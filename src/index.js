import { AwsClient } from "aws4fetch";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const MAX_UPLOAD_EXPIRY = 900;

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.APP_ORIGIN || "https://flaynity.indevs.in",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(data, status = 200, env) {
  const headers = new Headers(JSON_HEADERS);
  Object.entries(corsHeaders(env)).forEach(([k, v]) => headers.set(k, v));
  return new Response(JSON.stringify(data), { status, headers });
}

function unauthorized(env, message = "Unauthorized") {
  return json({ error: message }, 401, env);
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const text = new TextDecoder();
  return {
    header: JSON.parse(text.decode(base64UrlDecode(parts[0]))),
    payload: JSON.parse(text.decode(base64UrlDecode(parts[1]))),
    signature: base64UrlDecode(parts[2]),
    signingInput: new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  };
}

let certCache = { expiresAt: 0, keys: new Map() };

async function fetchGoogleJwks(forceRefresh = false) {
  const url = forceRefresh
    ? `https://www.googleapis.com/oauth2/v3/certs?flaynity_refresh=${Date.now()}`
    : "https://www.googleapis.com/oauth2/v3/certs";
  const response = await fetch(url, forceRefresh
    ? { cache: "no-store" }
    : { cf: { cacheTtl: 3600 } });
  if (!response.ok) throw new Error("Could not load Google signing keys");
  const body = await response.json();
  const keys = new Map();
  for (const jwk of body.keys || []) {
    if (jwk.kty === "RSA" && jwk.kid) {
      keys.set(jwk.kid, await crypto.subtle.importKey(
        "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
      ));
    }
  }
  const maxAge = Number((response.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1] || 3600);
  certCache = { expiresAt: Date.now() + Math.min(maxAge, 3600) * 1000, keys };
  return keys;
}

async function getGoogleJwks(forceRefresh = false) {
  if (!forceRefresh && Date.now() < certCache.expiresAt && certCache.keys.size) return certCache.keys;
  return fetchGoogleJwks(forceRefresh);
}

async function verifyFirebaseToken(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) throw new Error("Missing bearer token");
  const token = auth.slice(7).trim();
  const { header, payload, signature, signingInput } = decodeJwt(token);
  let keys = await getGoogleJwks();
  let key = keys.get(header.kid);

  // Google rotates Firebase signing keys. If the cached JWKS does not contain
  // the token's kid, refresh the keys immediately before rejecting the token.
  if (!key) {
    keys = await getGoogleJwks(true);
    key = keys.get(header.kid);
  }
  if (!key) throw new Error("Unknown token key");

  const valid = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signingInput);
  if (!valid) throw new Error("Invalid token signature");

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now || payload.iat > now + 60) throw new Error("Expired token");
  if (payload.aud !== env.FIREBASE_PROJECT_ID) throw new Error("Wrong audience");
  if (payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`) throw new Error("Wrong issuer");
  if (!payload.sub) throw new Error("Missing user id");
  return payload;
}

function sanitizeKey(input) {
  const key = String(input || "").replace(/^\/+/, "");
  if (!key || key.length > 700 || key.includes("..") || !/^uploads\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(key)) return null;
  return key;
}

async function createPresignedPut(env, key, contentType) {
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.MEDIA_BUCKET_NAME || "flaynity-storage"}/${key}`;
  const expires = MAX_UPLOAD_EXPIRY;
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto"
  });
  const request = new Request(`${endpoint}?X-Amz-Expires=${expires}`, {
    method: "PUT",
    headers: { "Content-Type": contentType }
  });
  const signed = await client.sign(request, { aws: { signQuery: true } });
  return signed.url.toString();
}

async function handleUploadUrl(request, env) {
  try {
    await verifyFirebaseToken(request, env);
  } catch (e) {
    return unauthorized(env, e.message || "Unauthorized");
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, env); }
  const key = sanitizeKey(body.key);
  const contentType = String(body.contentType || "application/octet-stream").slice(0, 120);
  if (!key) return json({ error: "Invalid media key" }, 400, env);
  if (!/^(image|video|audio)\//i.test(contentType)) return json({ error: "Unsupported content type" }, 400, env);

  const uploadUrl = await createPresignedPut(env, key, contentType);
  const mediaBase = env.MEDIA_BASE_URL || `${new URL(request.url).origin}/media`;
  return json({ key, uploadUrl, publicUrl: `${mediaBase}/${key.split("/").map(encodeURIComponent).join("/")}`, expiresIn: MAX_UPLOAD_EXPIRY }, 200, env);
}

async function handleMedia(request, env, key) {
  const obj = await env.MEDIA_BUCKET.get(key, { range: request.headers });
  if (!obj) return new Response("Not found", { status: 404, headers: corsHeaders(env) });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  Object.entries(corsHeaders(env)).forEach(([k, v]) => headers.set(k, v));

  const status = obj.range ? 206 : 200;
  if (obj.range) {
    const r = obj.range;
    if (r.offset != null && r.length != null) {
      headers.set("Content-Range", `bytes ${r.offset}-${r.offset + r.length - 1}/${obj.size}`);
      headers.set("Content-Length", String(r.length));
    }
  } else {
    headers.set("Content-Length", String(obj.size));
  }
  return new Response(request.method === "HEAD" ? null : obj.body, { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });

    if (url.pathname === "/api/health") return json({ ok: true, service: "flaynity-server", time: Date.now() }, 200, env);
    if (url.pathname === "/api/v1/media/upload-url" && request.method === "POST") return handleUploadUrl(request, env);

    if (url.pathname.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) {
      const key = decodeURIComponent(url.pathname.slice("/media/".length));
      if (!/^uploads\//.test(key) || key.includes("..")) return new Response("Bad key", { status: 400 });
      return handleMedia(request, env, key);
    }

    return json({ error: "Not found" }, 404, env);
  }
};
