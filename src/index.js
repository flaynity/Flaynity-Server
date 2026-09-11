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
const JWKS_CACHE_SECONDS = 300;

async function fetchGoogleJwks(forceRefresh = false) {
  const url = forceRefresh
    ? `https://www.googleapis.com/oauth2/v3/certs?flaynity_refresh=${Date.now()}_${Math.random().toString(36).slice(2)}`
    : "https://www.googleapis.com/oauth2/v3/certs";

  const response = await fetch(url, {
    headers: {
      "Cache-Control": forceRefresh ? "no-cache" : "max-age=300"
    },
    ...(forceRefresh ? { cache: "no-store" } : { cf: { cacheTtl: JWKS_CACHE_SECONDS } })
  });

  if (!response.ok) throw new Error("Could not load Google signing keys");
  const body = await response.json();
  const keys = new Map();

  for (const jwk of body.keys || []) {
    if (jwk.kty === "RSA" && jwk.kid && jwk.n && jwk.e) {
      keys.set(jwk.kid, await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      ));
    }
  }

  if (!keys.size) throw new Error("Google signing keys unavailable");

  const headerMaxAge = Number((response.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1] || JWKS_CACHE_SECONDS);
  const cacheSeconds = Math.min(Math.max(headerMaxAge, 60), JWKS_CACHE_SECONDS);
  certCache = { expiresAt: Date.now() + cacheSeconds * 1000, keys };
  return keys;
}

async function getGoogleJwks(forceRefresh = false) {
  if (!forceRefresh && Date.now() < certCache.expiresAt && certCache.keys.size) return certCache.keys;
  return fetchGoogleJwks(forceRefresh);
}

async function verifyFirebaseToken(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  if (!/^Bearer\s+/i.test(authHeader)) throw new Error("Authentication token missing");
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("Authentication token missing");

  // Primary path: locally verify the Firebase ID token using Google's public
  // signing keys. A missing kid is handled by an immediate JWKS refresh.
  try {
    const { header, payload, signature, signingInput } = decodeJwt(token);
    if (header.alg !== "RS256" || !header.kid) throw new Error("Invalid authentication token header");

    let keys = await getGoogleJwks();
    let key = keys.get(header.kid);
    if (!key) {
      keys = await getGoogleJwks(true);
      key = keys.get(header.kid);
    }
    if (!key) throw new Error("Unknown token key");

    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" }, key, signature, signingInput
    );
    if (!valid) throw new Error("Invalid token signature");

    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp <= now) throw new Error("Authentication token expired");
    if (payload.iat && payload.iat > now + 60) throw new Error("Authentication token issued in the future");
    if (payload.aud !== env.FIREBASE_PROJECT_ID) throw new Error("Authentication token has wrong audience");
    if (payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`) throw new Error("Authentication token has wrong issuer");
    if (!payload.sub) throw new Error("Authentication token has no user id");
    return payload;
  } catch (primaryError) {
    // Fallback: ask Firebase Identity Toolkit to validate the ID token itself.
    // This is used only when local Google-key verification fails (for example
    // during a signing-key rotation/cache propagation window). The Firebase
    // Web API key is a public application identifier, not an R2 credential.
    try {
      const firebaseApiKey = env.FIREBASE_WEB_API_KEY || "AIzaSyCiUTQp_QDSbBIOGJXKI7jJmzQHPu8L14I";
      const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: token }),
        cache: "no-store"
      });
      if (response.ok) {
        const info = await response.json();
        const account = Array.isArray(info.users) ? info.users[0] : null;
        if (account && account.localId) {
          return {
            sub: account.localId,
            user_id: account.localId,
            aud: env.FIREBASE_PROJECT_ID,
            iss: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
            email: account.email || undefined,
            email_verified: !!account.emailVerified,
            auth_time: account.lastLoginAt ? Math.floor(Number(account.lastLoginAt) / 1000) : undefined
          };
        }
      }
    } catch (fallbackError) {
      // Fall through to the original verification error.
    }
    throw primaryError;
  }
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



function mediaPublicUrl(env, key) {
  const base = String(env.MEDIA_BASE_URL || "").replace(/\/+$/, "") || "https://cdn.flaynity.indevs.in/media";
  return `${base}/${String(key).split("/").map(encodeURIComponent).join("/")}`;
}

async function handleTranscodeCreate(request, env) {
  try { await verifyFirebaseToken(request, env); }
  catch (e) { return unauthorized(env, e.message || "Unauthorized"); }
  if (!env.TRANSCODER_URL || !env.TRANSCODER_SECRET) {
    return json({ error: "HLS transcoder is not configured on the server." }, 503, env);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, env); }
  const sourceKey = sanitizeKey(body.key);
  if (!sourceKey || !/^uploads\/(feels|videos)\//.test(sourceKey)) return json({ error: "Invalid video key" }, 400, env);
  const contentType = String(body.contentType || "video/mp4").slice(0, 120);
  try {
    const r = await fetch(`${String(env.TRANSCODER_URL).replace(/\/+$/, "")}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flaynity-transcoder-secret": String(env.TRANSCODER_SECRET) },
      body: JSON.stringify({ sourceKey, contentType })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.jobId) return json({ error: data.error || `Transcoder rejected job (${r.status})` }, 502, env);
    const hlsKey = `uploads/hls/${data.jobId}/master.m3u8`;
    return json({
      jobId: data.jobId,
      status: data.status || "queued",
      hlsUrl: mediaPublicUrl(env, hlsKey),
      hlsKey,
      provider: "r2-hls"
    }, 202, env);
  } catch (e) { return json({ error: e.message || "Could not contact HLS transcoder" }, 503, env); }
}

async function handleTranscodeStatus(request, env, jobId) {
  try { await verifyFirebaseToken(request, env); }
  catch (e) { return unauthorized(env, e.message || "Unauthorized"); }
  if (!env.TRANSCODER_URL || !env.TRANSCODER_SECRET) return json({ error: "HLS transcoder is not configured." }, 503, env);
  if (!/^[a-f0-9-]{20,80}$/i.test(jobId)) return json({ error: "Invalid transcode job id" }, 400, env);
  try {
    const r = await fetch(`${String(env.TRANSCODER_URL).replace(/\/+$/, "")}/jobs/${encodeURIComponent(jobId)}`, {
      headers: { "x-flaynity-transcoder-secret": String(env.TRANSCODER_SECRET) },
      cache: "no-store"
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: data.error || `Transcoder status failed (${r.status})` }, r.status === 404 ? 404 : 502, env);
    const hlsKey = `uploads/hls/${jobId}/master.m3u8`;
    return json({ ...data, hlsUrl: mediaPublicUrl(env, hlsKey), hlsKey, provider: "r2-hls" }, 200, env);
  } catch (e) { return json({ error: e.message || "Could not read transcoder status" }, 503, env); }
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

  try {
    const uploadUrl = await createPresignedPut(env, key, contentType);
    const mediaBase = env.MEDIA_BASE_URL || `${new URL(request.url).origin}/media`;
    return json({ key, uploadUrl, publicUrl: `${mediaBase}/${key.split("/").map(encodeURIComponent).join("/")}`, expiresIn: MAX_UPLOAD_EXPIRY }, 200, env);
  } catch (e) {
    return json({ error: e?.message || "Could not create upload URL" }, 500, env);
  }
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
    if (url.pathname === "/api/v1/media/transcode" && request.method === "POST") return handleTranscodeCreate(request, env);
    if (url.pathname.startsWith("/api/v1/media/transcode/status/") && request.method === "GET") return handleTranscodeStatus(request, env, url.pathname.slice("/api/v1/media/transcode/status/".length));
    if (url.pathname === "/api/v1/stream/capability" && request.method === "GET") return json({ enabled:false, provider:"r2-hls", preferredQualityLadder:[144,360,480,720,1080], advertisedMinimum:144 }, 200, env);

    if (url.pathname.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) {
      const key = decodeURIComponent(url.pathname.slice("/media/".length));
      if (!/^uploads\//.test(key) || key.includes("..")) return new Response("Bad key", { status: 400 });
      return handleMedia(request, env, key);
    }

    return json({ error: "Not found" }, 404, env);
  }
};
