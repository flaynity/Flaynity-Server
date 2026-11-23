import { AwsClient } from "aws4fetch";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_UPLOAD_EXPIRY = 900;

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.APP_ORIGIN || "https://flaynity-app.indevs.in",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Range,X-Requested-With",
    "Access-Control-Expose-Headers": "Accept-Ranges,Content-Length,Content-Range,ETag,Content-Type",
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
    ? `https://www.googleapis.com/oauth2/v3/certs?flaynity_refresh=${Date.now()}`
    : "https://www.googleapis.com/oauth2/v3/certs";
  const response = await fetch(url, {
    headers: { "Cache-Control": forceRefresh ? "no-cache" : "max-age=300" },
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
  const maxAge = Number((response.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1] || JWKS_CACHE_SECONDS);
  certCache = { expiresAt: Date.now() + Math.min(Math.max(maxAge, 60), JWKS_CACHE_SECONDS) * 1000, keys };
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
    if (!await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signingInput)) {
      throw new Error("Invalid token signature");
    }
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp <= now) throw new Error("Authentication token expired");
    if (payload.iat && payload.iat > now + 60) throw new Error("Authentication token issued in the future");
    if (payload.aud !== env.FIREBASE_PROJECT_ID) throw new Error("Authentication token has wrong audience");
    if (payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`) throw new Error("Authentication token has wrong issuer");
    if (!payload.sub) throw new Error("Authentication token has no user id");
    return payload;
  } catch (primaryError) {
    try {
      const key = env.FIREBASE_WEB_API_KEY || "AIzaSyCiUTQp_QDSbBIOGJXKI7jJmzQHPu8L14I";
      const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idToken: token }),
        cache: "no-store"
      });
      if (response.ok) {
        const info = await response.json();
        const account = Array.isArray(info.users) ? info.users[0] : null;
        if (account?.localId) {
          return {
            sub: account.localId,
            user_id: account.localId,
            aud: env.FIREBASE_PROJECT_ID,
            iss: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
            email: account.email || undefined,
            email_verified: !!account.emailVerified
          };
        }
      }
    } catch {}
    throw primaryError;
  }
}

// Accept both the old key format:
//   uploads/<user>/<file>
// and the Video/Feels formats:
//   uploads/videos/<user>/<file>
//   uploads/feels/<user>/<file>
function sanitizeKey(input) {
  const key = String(input || "").replace(/^\/+/, "");
  if (!key || key.length > 700 || key.includes("..")) return null;
  if (!/^uploads\/(?:[a-zA-Z0-9_-]+\/){1,2}[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(key)) return null;
  return key;
}

function mediaUrl(request, env, key) {
  // Prefer the same Worker for the public media URL. This prevents an upload
  // from succeeding in R2 while a separate/stale CDN Worker returns 404.
  const configured = String(env.MEDIA_BASE_URL || "").trim().replace(/\/$/, "");
  const requestOrigin = new URL(request.url).origin;
  const mediaBase = configured && !/cdn\.flaynity\.indevs\.in$/i.test(new URL(configured).hostname)
    ? configured
    : `${requestOrigin}/media`;
  return `${mediaBase}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function createPresignedPut(env, key, contentType) {
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.MEDIA_BUCKET_NAME || "flaynity-storage"}/${key}`;
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto"
  });

  // Do not sign Content-Type. WebView/browser implementations sometimes
  // normalize it differently; signing it made valid Video/Feels uploads fail
  // even after the file reached 100%.
  const signed = await client.sign(
    new Request(`${endpoint}?X-Amz-Expires=${MAX_UPLOAD_EXPIRY}`, { method: "PUT" }),
    { aws: { signQuery: true } }
  );
  return signed.url.toString();
}

async function handleUploadUrl(request, env) {
  try {
    await verifyFirebaseToken(request, env);
  } catch (e) {
    return unauthorized(env, e.message || "Unauthorized");
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, env);
  }

  const key = sanitizeKey(body.key);
  const contentType = String(body.contentType || "application/octet-stream").slice(0, 120);
  if (!key) return json({ error: "Invalid media key" }, 400, env);
  if (!/^(image|video|audio)\//i.test(contentType)) return json({ error: "Unsupported content type" }, 400, env);

  try {
    const uploadUrl = await createPresignedPut(env, key, contentType);
    return json({
      ok: true,
      key,
      uploadUrl,
      publicUrl: mediaUrl(request, env, key),
      expiresIn: MAX_UPLOAD_EXPIRY,
      contentType,
      videoProvider: /\/(videos|feels)\//i.test(key) ? "r2" : undefined
    }, 200, env);
  } catch (e) {
    return json({ error: e?.message || "Could not create upload URL" }, 500, env);
  }
}

async function handleMedia(request, env, key) {
  const obj = await env.MEDIA_BUCKET.get(key, { range: request.headers });
  if (!obj) {
    return new Response("Not found", {
      status: 404,
      headers: { ...corsHeaders(env), "Cache-Control": "no-store" }
    });
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  const lowerKey = key.toLowerCase();
  if (lowerKey.endsWith(".m3u8")) {
    headers.set("Content-Type", "application/vnd.apple.mpegurl");
    headers.set("Cache-Control", "public, max-age=3600");
  } else if (lowerKey.endsWith(".ts")) {
    headers.set("Content-Type", "video/MP2T");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else if (lowerKey.endsWith(".json")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.set("Cache-Control", "no-store");
  } else if (/\.(mp4|webm|mov|mkv)$/i.test(lowerKey)) {
    headers.set(
      "Content-Type",
      lowerKey.endsWith(".mp4")
        ? "video/mp4"
        : lowerKey.endsWith(".webm")
          ? "video/webm"
          : "video/quicktime"
    );
  }

  Object.entries(corsHeaders(env)).forEach(([k, v]) => headers.set(k, v));
  const status = obj.range ? 206 : 200;

  if (obj.range?.offset != null && obj.range?.length != null) {
    headers.set("Content-Range", `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`);
    headers.set("Content-Length", String(obj.range.length));
  } else {
    headers.set("Content-Length", String(obj.size));
  }

  return new Response(request.method === "HEAD" ? null : obj.body, { status, headers });
}

async function handleStartHlsTranscode(request, env) {
  try {
    await verifyFirebaseToken(request, env);
  } catch (e) {
    return unauthorized(env, e.message || "Unauthorized");
  }

  if (!env.MODAL_TRANSCODE_URL || !env.GPU_WEBHOOK_SECRET) {
    return json({ ok: false, error: "GPU transcoder is not configured" }, 503, env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400, env);
  }

  const inputKey = String(body.inputKey || body.key || "").trim().replace(/^\/+/, "");
  if (!inputKey || inputKey.includes("..") || !/^uploads\//.test(inputKey)) {
    return json({ ok: false, error: "Invalid inputKey" }, 400, env);
  }

  const headObj = await env.MEDIA_BUCKET.head(inputKey);
  if (!headObj) {
    return json({ ok: false, error: "Source video not found in R2" }, 404, env);
  }

  const rawJobId = String(body.jobId || `job_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`);
  const jobId = rawJobId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
  if (!jobId) {
    return json({ ok: false, error: "Invalid jobId" }, 400, env);
  }

  const modalResponse = await fetch(env.MODAL_TRANSCODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: env.GPU_WEBHOOK_SECRET,
      jobId,
      inputKey,
      qualities: Array.isArray(body.qualities) && body.qualities.length
        ? body.qualities
        : ["360p", "480p", "720p", "1080p"],
      deleteOriginal: Boolean(body.deleteOriginal)
    })
  });

  const modalData = await modalResponse.json().catch(() => ({}));
  if (!modalResponse.ok) {
    return json({
      ok: false,
      error: "Failed to queue GPU transcode job",
      details: modalData
    }, 502, env);
  }

  const masterKey = `uploads/hls/${jobId}/master.m3u8`;
  const statusKey = `uploads/hls/${jobId}/status.json`;
  return json({
    ok: true,
    jobId,
    status: modalData.status || "queued",
    masterUrl: modalData.masterUrl || mediaUrl(request, env, masterKey),
    statusUrl: modalData.statusUrl || mediaUrl(request, env, statusKey)
  }, 202, env);
}

async function handleGetHlsStatus(request, env, rawJobId) {
  const jobId = String(rawJobId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
  if (!jobId) {
    return json({ ok: false, error: "Invalid jobId" }, 400, env);
  }

  const obj = await env.MEDIA_BUCKET.get(`uploads/hls/${jobId}/status.json`);
  if (!obj) {
    return json({ ok: false, status: "not_found", jobId }, 404, env);
  }

  const headers = new Headers(JSON_HEADERS);
  Object.entries(corsHeaders(env)).forEach(([k, v]) => headers.set(k, v));
  return new Response(obj.body, { status: 200, headers });
}

export default {
  async scheduled() {},

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (url.pathname === "/api/health" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "flaynity-server",
        videoPipeline: "r2-hls-modal",
        ffmpeg: true,
        hls: true,
        gpuConfigured: Boolean(env.MODAL_TRANSCODE_URL && env.GPU_WEBHOOK_SECRET),
        time: Date.now()
      }, 200, env);
    }

    if (url.pathname === "/api/v1/media/upload-url" && request.method === "POST") {
      return handleUploadUrl(request, env);
    }

    if ((url.pathname === "/api/v1/transcode/hls" || url.pathname === "/transcode/hls") && request.method === "POST") {
      return handleStartHlsTranscode(request, env);
    }

    if ((url.pathname.startsWith("/api/v1/transcode/status/") || url.pathname.startsWith("/transcode/status/")) && request.method === "GET") {
      const jobId = url.pathname.replace(/^\/(?:api\/v1\/)?transcode\/status\//, "");
      return handleGetHlsStatus(request, env, jobId);
    }

    if (url.pathname.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) {
      let key;
      try {
        key = decodeURIComponent(url.pathname.slice("/media/".length));
      } catch {
        return new Response("Bad key", { status: 400, headers: corsHeaders(env) });
      }
      if (!/^uploads\//.test(key) || key.includes("..")) {
        return new Response("Bad key", { status: 400, headers: corsHeaders(env) });
      }
      return handleMedia(request, env, key);
    }

    return json({ error: "Not found" }, 404, env);
  }
};
