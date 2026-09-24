import { AwsClient } from "aws4fetch";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_UPLOAD_EXPIRY = 900;
const ALLOWED_VIDEO_TYPES = new Set(["video/mp4"]);

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
function unauthorized(env, message = "Unauthorized") { return json({ error: message }, 401, env); }
function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const bin = atob(padded); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function decodeJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token");
  const text = new TextDecoder();
  return { header: JSON.parse(text.decode(base64UrlDecode(parts[0]))), payload: JSON.parse(text.decode(base64UrlDecode(parts[1]))), signature: base64UrlDecode(parts[2]), signingInput: new TextEncoder().encode(`${parts[0]}.${parts[1]}`) };
}
let certCache = { expiresAt: 0, keys: new Map() };
const JWKS_CACHE_SECONDS = 300;
async function fetchGoogleJwks(forceRefresh = false) {
  const url = forceRefresh ? `https://www.googleapis.com/oauth2/v3/certs?flaynity_refresh=${Date.now()}_${Math.random().toString(36).slice(2)}` : "https://www.googleapis.com/oauth2/v3/certs";
  const response = await fetch(url, { headers: { "Cache-Control": forceRefresh ? "no-cache" : "max-age=300" }, ...(forceRefresh ? { cache: "no-store" } : { cf: { cacheTtl: JWKS_CACHE_SECONDS } }) });
  if (!response.ok) throw new Error("Could not load Google signing keys");
  const body = await response.json(); const keys = new Map();
  for (const jwk of body.keys || []) if (jwk.kty === "RSA" && jwk.kid && jwk.n && jwk.e) keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  if (!keys.size) throw new Error("Google signing keys unavailable");
  const headerMaxAge = Number((response.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1] || JWKS_CACHE_SECONDS);
  certCache = { expiresAt: Date.now() + Math.min(Math.max(headerMaxAge, 60), JWKS_CACHE_SECONDS) * 1000, keys }; return keys;
}
async function getGoogleJwks(forceRefresh = false) { if (!forceRefresh && Date.now() < certCache.expiresAt && certCache.keys.size) return certCache.keys; return fetchGoogleJwks(forceRefresh); }
async function verifyFirebaseToken(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  if (!/^Bearer\s+/i.test(authHeader)) throw new Error("Authentication token missing");
  const token = authHeader.replace(/^Bearer\s+/i, "").trim(); if (!token) throw new Error("Authentication token missing");
  try {
    const { header, payload, signature, signingInput } = decodeJwt(token);
    if (header.alg !== "RS256" || !header.kid) throw new Error("Invalid authentication token header");
    let keys = await getGoogleJwks(); let key = keys.get(header.kid); if (!key) { keys = await getGoogleJwks(true); key = keys.get(header.kid); }
    if (!key) throw new Error("Unknown token key");
    if (!await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signingInput)) throw new Error("Invalid token signature");
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp <= now) throw new Error("Authentication token expired");
    if (payload.iat && payload.iat > now + 60) throw new Error("Authentication token issued in the future");
    if (payload.aud !== env.FIREBASE_PROJECT_ID) throw new Error("Authentication token has wrong audience");
    if (payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`) throw new Error("Authentication token has wrong issuer");
    if (!payload.sub) throw new Error("Authentication token has no user id"); return payload;
  } catch (primaryError) {
    try {
      const firebaseApiKey = env.FIREBASE_WEB_API_KEY || "AIzaSyCiUTQp_QDSbBIOGJXKI7jJmzQHPu8L14I";
      const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: token }), cache: "no-store" });
      if (response.ok) { const info = await response.json(); const account = Array.isArray(info.users) ? info.users[0] : null; if (account?.localId) return { sub: account.localId, user_id: account.localId, aud: env.FIREBASE_PROJECT_ID, iss: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`, email: account.email || undefined, email_verified: !!account.emailVerified }; }
    } catch {}
    throw primaryError;
  }
}
function sanitizeKey(input) {
  const key = String(input || "").replace(/^\/+/, "");
  if (!key || key.length > 700 || key.includes("..") || !/^uploads\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+$/.test(key)) return null; return key;
}
function sanitizeSourceKey(input) {
  const key = String(input || "").replace(/^\/+/, "");
  if (!key || key.length > 700 || key.includes("..") || !/^uploads\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+\.(mp4|webm|mov|mkv)$/i.test(key)) return null; return key;
}
async function createPresignedPut(env, key, contentType) {
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.MEDIA_BUCKET_NAME || "flaynity-storage"}/${key}`;
  const client = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const signed = await client.sign(new Request(`${endpoint}?X-Amz-Expires=${MAX_UPLOAD_EXPIRY}`, { method: "PUT", headers: { "Content-Type": contentType } }), { aws: { signQuery: true } });
  return signed.url.toString();
}
async function handleUploadUrl(request, env) {
  try { await verifyFirebaseToken(request, env); } catch (e) { return unauthorized(env, e.message || "Unauthorized"); }
  let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, env); }
  const key = sanitizeKey(body.key); const contentType = String(body.contentType || "application/octet-stream").slice(0, 120);
  if (!key) return json({ error: "Invalid media key" }, 400, env);
  if (!/^(image|video|audio)\//i.test(contentType)) return json({ error: "Unsupported content type" }, 400, env);
  try { const uploadUrl = await createPresignedPut(env, key, contentType); const mediaBase = env.MEDIA_BASE_URL || `${new URL(request.url).origin}/media`; return json({ key, uploadUrl, publicUrl: `${mediaBase}/${key.split("/").map(encodeURIComponent).join("/")}`, expiresIn: MAX_UPLOAD_EXPIRY }, 200, env); }
  catch (e) { return json({ error: e?.message || "Could not create upload URL" }, 500, env); }
}
const pendingPrefix = "internal/pending/";
let firebaseAccess = { account: "", token: "", expiresAt: 0 };
function base64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
function encodeJson(value) { return base64url(new TextEncoder().encode(JSON.stringify(value))); }
async function firebaseToken(env) {
  const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  if (account.project_id !== env.FIREBASE_PROJECT_ID) throw new Error("Firebase service account project mismatch");
  if (firebaseAccess.account === account.client_email && Date.now() < firebaseAccess.expiresAt) return firebaseAccess.token;
  const now = Math.floor(Date.now() / 1000);
  const input = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({ iss: account.client_email, scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const keyBytes = Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${input}.${base64url(new Uint8Array(signature))}` }) });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error("Firebase service-account authorization failed");
  firebaseAccess = { account: account.client_email, token: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) - 120) * 1000 };
  return data.access_token;
}
async function firebaseRequest(env, dbPath, options = {}) {
  const base = String(env.FIREBASE_DATABASE_URL || "").replace(/\/$/, "");
  if (!/^https:\/\/[^/]+\.(firebaseio\.com|firebasedatabase\.app)$/.test(base)) throw new Error("Set FIREBASE_DATABASE_URL to the HTTPS Realtime Database root URL");
  const response = await fetch(`${base}/${dbPath}.json`, { ...options, headers: { "Authorization": `Bearer ${await firebaseToken(env)}`, "Content-Type": "application/json", ...options.headers } });
  if (!response.ok) { const error = new Error(`Firebase request failed (${response.status})`); error.status = response.status; throw error; }
  return response;
}

function directVideoUrl(env, sourceKey) {
  return `${(env.MEDIA_BASE_URL || "https://cdn.flaynity.indevs.in/media").replace(/\/$/, "")}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`;
}
function directPlaybackMetadata(sourceKey, videoUrl) {
  return {
    videoProvider: "r2",
    videoUrl,
    videoLink: videoUrl,
    sourceKey,
    videoStatus: "ready",
    hlsStatus: "disabled",
    hlsError: "",
    hlsJobId: null,
    hlsUrl: null,
    hlsManifestUrl: null,
    hlsManifestVersion: 0,
    availableQualities: [],
    videoQualities: { auto: videoUrl, preferred: [] },
    streamQualityLadder: []
  };
}
async function publishDirectVideo(env, publicationPath, authUserId, sourceKey, videoUrl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await firebaseRequest(env, publicationPath, { headers: { "X-Firebase-ETag": "true" } });
    const record = await response.json();
    if (!record || record.userId !== authUserId || !["published", "scheduled"].includes(record.status)) return false;
    const updated = { ...record, ...directPlaybackMetadata(sourceKey, videoUrl), updateTime: Date.now() };
    try {
      await firebaseRequest(env, publicationPath, {
        method: "PUT",
        headers: { "if-match": response.headers.get("etag") || "*" },
        body: JSON.stringify(updated)
      });
      return true;
    } catch (e) {
      if (e.status !== 412 || attempt === 2) throw e;
    }
  }
  return false;
}
async function handleTranscode(request, env) {
  let auth; try { auth = await verifyFirebaseToken(request, env); } catch (e) { return unauthorized(env, e.message); }
  let body; try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, env); }
  const sourceKey = sanitizeSourceKey(body.sourceKey);
  const contentType = String(body.contentType || "video/mp4").split(";")[0].toLowerCase();
  if (!sourceKey || !/\.mp4$/i.test(sourceKey) || contentType !== "video/mp4" || !/^[a-zA-Z0-9_-]{1,120}$/.test(body.contentId || "") || !["video-short", "video-long"].includes(body.type)) {
    return json({ error: "Invalid MP4 video source, content ID or type" }, 400, env);
  }
  try {
    await firebaseToken(env);
    if (!await env.MEDIA_BUCKET.head(sourceKey)) return json({ error: "Source upload is not complete" }, 409, env);
    const videoUrl = directVideoUrl(env, sourceKey);
    const publicationPath = `admin_panel/movies/${body.type === "video-short" ? "feels" : "user_uploads"}/${body.contentId}`;
    const published = await publishDirectVideo(env, publicationPath, auth.sub, sourceKey, videoUrl);
    if (!published) return json({ error: "Firebase publication record is missing or cannot be updated" }, 409, env);
    return json({
      videoProvider: "r2",
      videoUrl,
      videoLink: videoUrl,
      sourceKey,
      status: "ready",
      progress: 100,
      available: [],
      currentQuality: null,
      error: "",
      publishedAt: Date.now()
    }, 200, env);
  } catch (e) {
    return json({ error: e?.message || "Could not publish MP4 video" }, 503, env);
  }
}
async function handleMedia(request, env, key) {
  const obj = await env.MEDIA_BUCKET.get(key, { range: request.headers }); if (!obj) return new Response("Not found", { status: 404, headers: { ...corsHeaders(env), "Cache-Control": "no-store" } });
  const headers = new Headers(); obj.writeHttpMetadata(headers); headers.set("etag", obj.httpEtag); headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", key.endsWith("/master.m3u8") ? "no-store" : "public, max-age=31536000, immutable");
  if (/\.mp4$/i.test(key)) headers.set("Content-Type", "video/mp4"); else if (/\.webm$/i.test(key)) headers.set("Content-Type", "video/webm"); else if (/\.mov$/i.test(key)) headers.set("Content-Type", "video/quicktime");
  Object.entries(corsHeaders(env)).forEach(([k, v]) => headers.set(k, v)); const status = obj.range ? 206 : 200;
  if (obj.range?.offset != null && obj.range?.length != null) { headers.set("Content-Range", `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`); headers.set("Content-Length", String(obj.range.length)); } else headers.set("Content-Length", String(obj.size));
  return new Response(request.method === "HEAD" ? null : obj.body, { status, headers });
}
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (url.pathname === "/api/health") return json({ ok: true, service: "flaynity-server", videoPipeline: "r2-mp4", ffmpeg: false, time: Date.now() }, 200, env);
  if (url.pathname === "/api/v1/media/upload-url" && request.method === "POST") return handleUploadUrl(request, env);
  if (url.pathname === "/api/v1/media/transcode" && request.method === "POST") return handleTranscode(request, env);
  if (url.pathname.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) {
    const key = decodeURIComponent(url.pathname.slice("/media/".length));
    if ((!/^uploads\//.test(key)) || key.includes("..")) return new Response("Bad key", { status: 400 });
    return handleMedia(request, env, key);
  }
  return json({ error: "Not found" }, 404, env);
} };
