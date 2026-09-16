import { AwsClient } from "aws4fetch";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const MAX_UPLOAD_EXPIRY = 900;
const HLS_PREFIX = "uploads/hls/";
const ALLOWED_HLS_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"]);
const MUX_API_BASE = "https://api.mux.com";
const MUX_UPLOAD_PREFIX = "internal/mux/uploads/";
const MUX_WEBHOOK_TOLERANCE_SECONDS = 300;

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

function requireMuxConfig(env) {
  if (!env.MUX_TOKEN_ID || !env.MUX_TOKEN_SECRET) throw new Error("Configure MUX_TOKEN_ID and MUX_TOKEN_SECRET");
}
function muxBasicAuth(env) {
  return `Basic ${btoa(`${env.MUX_TOKEN_ID}:${env.MUX_TOKEN_SECRET}`)}`;
}
async function muxRequest(env, path, options = {}) {
  requireMuxConfig(env);
  const response = await fetch(`${MUX_API_BASE}${path}`, {
    ...options,
    headers: {
      "Authorization": muxBasicAuth(env),
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.messages?.[0] || data?.error?.message || data?.message || `Mux API request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}
function muxSafeId(value, max = 128) {
  const id = String(value || "").trim();
  return id && id.length <= max ? id : null;
}
function muxPublicationPath(type, contentId) {
  return `admin_panel/movies/${type === "video-short" ? "feels" : "user_uploads"}/${contentId}`;
}
function muxPlaybackUrl(playbackId) {
  return playbackId ? `https://stream.mux.com/${encodeURIComponent(playbackId)}.m3u8` : "";
}
async function muxWebhookSignatureValid(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = {};
  for (const part of String(signatureHeader).split(",")) {
    const index = part.indexOf("=");
    if (index > 0) parts[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  const timestamp = Number(parts.t);
  const provided = String(parts.v1 || "").toLowerCase();
  if (!Number.isFinite(timestamp) || !/^[0-9a-f]{64}$/.test(provided)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > MUX_WEBHOOK_TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  const expected = Array.from(digest, n => n.toString(16).padStart(2, "0")).join("");
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}
async function handleMuxCreateUpload(request, env) {
  let auth;
  try { auth = await verifyFirebaseToken(request, env); } catch (e) { return unauthorized(env, e.message); }
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400, env); }
  const type = String(body.type || "").trim();
  const contentId = muxSafeId(body.contentId, 120);
  const contentType = String(body.contentType || "video/mp4").split(";")[0].toLowerCase();
  if (!["video-short", "video-long"].includes(type) || !/^[a-zA-Z0-9_-]{1,120}$/.test(contentId || "")) return json({ error: "Invalid video type or content ID" }, 400, env);
  if (!ALLOWED_HLS_TYPES.has(contentType)) return json({ error: "Unsupported video content type" }, 400, env);
  try {
    requireMuxConfig(env);
    const token = crypto.randomUUID().replace(/-/g, "");
    const publicationPath = muxPublicationPath(type, contentId);
    const title = String(body.title || "").trim().slice(0, 512);
    const payload = {
      cors_origin: env.APP_ORIGIN || "https://flaynity.indevs.in",
      timeout: Math.min(Math.max(Number(body.timeout || 604800), 60), 604800),
      new_asset_settings: {
        playback_policies: ["public"],
        video_quality: "basic",
        max_resolution_tier: "1080p",
        passthrough: token,
        ...(title ? { meta: { title } } : {})
      }
    };
    const result = await muxRequest(env, "/video/v1/uploads", { method: "POST", body: JSON.stringify(payload) });
    const upload = result?.data;
    if (!upload?.id || !upload?.url) throw new Error("Mux did not return a direct upload URL");
    const record = {
      uploadId: upload.id,
      ownerId: auth.sub,
      contentId,
      type,
      publicationPath,
      passthrough: token,
      status: upload.status || "waiting",
      assetId: upload.asset_id || "",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    const recordJson = JSON.stringify(record);
    await env.MEDIA_BUCKET.put(`${MUX_UPLOAD_PREFIX}${token}.json`, recordJson, { httpMetadata: { contentType: "application/json" } });
    await env.MEDIA_BUCKET.put(`${MUX_UPLOAD_PREFIX}by-upload/${upload.id}.json`, recordJson, { httpMetadata: { contentType: "application/json" } });
    return json({
      provider: "mux",
      uploadId: upload.id,
      uploadUrl: upload.url,
      timeout: upload.timeout || payload.timeout,
      status: upload.status || "waiting",
      contentId,
      type
    }, 200, env);
  } catch (e) {
    return json({ error: e?.message || "Could not create Mux upload" }, e.status === 401 || e.status === 403 ? 502 : 503, env);
  }
}
async function handleMuxUploadStatus(request, env, uploadId) {
  let auth;
  try { auth = await verifyFirebaseToken(request, env); } catch (e) { return unauthorized(env, e.message); }
  if (!/^[a-zA-Z0-9_-]{10,200}$/.test(uploadId || "")) return json({ error: "Invalid upload ID" }, 400, env);
  try {
    const result = await muxRequest(env, `/video/v1/uploads/${encodeURIComponent(uploadId)}`);
    const upload = result?.data;
    if (!upload) return json({ error: "Mux upload not found" }, 404, env);
    const stored = await env.MEDIA_BUCKET.get(`${MUX_UPLOAD_PREFIX}by-upload/${uploadId}.json`);
    const record = stored ? await stored.json().catch(() => null) : null;
    if (record && record.ownerId !== auth.sub) return json({ error: "Upload belongs to another user" }, 403, env);
    const playbackId = "";
    return json({
      provider: "mux",
      uploadId: upload.id,
      status: upload.status,
      assetId: upload.asset_id || record?.assetId || "",
      error: upload.error || null,
      contentId: record?.contentId || "",
      type: record?.type || "",
      publicationPath: record?.publicationPath || "",
      playbackId,
      hlsUrl: ""
    }, 200, env);
  } catch (e) {
    return json({ error: e?.message || "Could not read Mux upload status" }, e.status === 404 ? 404 : 503, env);
  }
}
async function handleMuxCancelUpload(request, env, uploadId) {
  let auth;
  try { auth = await verifyFirebaseToken(request, env); } catch (e) { return unauthorized(env, e.message); }
  if (!/^[a-zA-Z0-9_-]{10,200}$/.test(uploadId || "")) return json({ error: "Invalid upload ID" }, 400, env);
  try {
    const stored = await env.MEDIA_BUCKET.get(`${MUX_UPLOAD_PREFIX}by-upload/${uploadId}.json`);
    const record = stored ? await stored.json().catch(() => null) : null;
    if (record && record.ownerId !== auth.sub) return json({ error: "Upload belongs to another user" }, 403, env);
    const result = await muxRequest(env, `/video/v1/uploads/${encodeURIComponent(uploadId)}/cancel`, { method: "PUT", body: "{}" });
    if (record) {
      record.status = result?.data?.status || "cancelled";
      record.updatedAt = Date.now();
      const recordJson = JSON.stringify(record);
      await env.MEDIA_BUCKET.put(`${MUX_UPLOAD_PREFIX}${record.passthrough}.json`, recordJson, { httpMetadata: { contentType: "application/json" } });
      await env.MEDIA_BUCKET.put(`${MUX_UPLOAD_PREFIX}by-upload/${uploadId}.json`, recordJson, { httpMetadata: { contentType: "application/json" } });
    }
    return json({ provider: "mux", uploadId, status: result?.data?.status || "cancelled" }, 200, env);
  } catch (e) {
    return json({ error: e?.message || "Could not cancel Mux upload" }, e.status === 404 ? 404 : 503, env);
  }
}
async function handleMuxWebhook(request, env) {
  if (!env.MUX_WEBHOOK_SECRET) return json({ error: "MUX_WEBHOOK_SECRET is not configured" }, 503, env);
  const rawBody = await request.text();
  if (!await muxWebhookSignatureValid(rawBody, request.headers.get("mux-signature"), env.MUX_WEBHOOK_SECRET)) return unauthorized(env, "Invalid Mux webhook signature");
  let event;
  try { event = JSON.parse(rawBody); } catch { return json({ error: "Invalid webhook JSON" }, 400, env); }
  const type = String(event?.type || "");
  const data = event?.data || {};
  const passthrough = muxSafeId(data?.passthrough, 128);
  if (!passthrough) return json({ ok: true, ignored: true }, 200, env);
  const objectKey = `${MUX_UPLOAD_PREFIX}${passthrough}.json`;
  const stored = await env.MEDIA_BUCKET.get(objectKey);
  if (!stored) return json({ ok: true, ignored: true }, 200, env);
  const record = await stored.json();
  if (["video.upload.asset_created", "video.asset.ready", "video.asset.errored", "video.upload.cancelled"].includes(type)) {
    record.updatedAt = Date.now();
    if (type === "video.upload.asset_created") {
      record.status = "asset_created";
      record.assetId = data?.asset_id || record.assetId || "";
      // Mux may expose playback_ids as soon as the asset is created. Keep the
      // ID in the server record, but do not mark the asset playable until the
      // video.asset.ready webhook arrives.
      const playback = Array.isArray(data?.playback_ids) ? data.playback_ids.find(item => item?.policy === "public") || data.playback_ids[0] : null;
      if (playback?.id) {
        record.playbackId = playback.id;
        record.hlsUrl = muxPlaybackUrl(playback.id);
      }
    } else if (type === "video.asset.ready") {
      record.status = "ready";
      record.assetId = data?.id || record.assetId || "";
      const playback = Array.isArray(data?.playback_ids) ? data.playback_ids.find(item => item?.policy === "public") || data.playback_ids[0] : null;
      record.playbackId = playback?.id || record.playbackId || "";
      record.hlsUrl = muxPlaybackUrl(record.playbackId);
      record.duration = Number(data?.duration || 0);
      record.aspectRatio = data?.aspect_ratio || "";
      record.sourceWidth = Number(data?.max_stored_resolution ? (data?.tracks?.find(t => t.type === "video")?.max_width || 0) : 0);
      record.sourceHeight = Number(data?.max_stored_resolution ? (data?.tracks?.find(t => t.type === "video")?.max_height || 0) : 0);
      try {
        const response = await firebaseRequest(env, record.publicationPath, { headers: { "X-Firebase-ETag": "true" } });
        const publication = await response.json();
        if (publication && publication.userId === record.ownerId && ["published", "scheduled"].includes(publication.status)) {
          await firebaseRequest(env, record.publicationPath, {
            method: "PUT",
            headers: { "if-match": response.headers.get("etag") },
            body: JSON.stringify({
              ...publication,
              videoProvider: "mux",
              videoLink: record.hlsUrl,
              videoUrl: record.hlsUrl,
              hlsUrl: record.hlsUrl,
              hlsManifestUrl: record.hlsUrl,
              hlsManifestVersion: Date.now(),
              muxUploadId: record.uploadId,
              muxAssetId: record.assetId,
              muxPlaybackId: record.playbackId,
              hlsStatus: "ready",
              hlsError: "",
              availableQualities: ["360p", "480p", "720p", "1080p"],
              streamQualityLadder: [360, 480, 720, 1080],
              videoQualities: { auto: record.hlsUrl, hls: record.hlsUrl, preferred: [360, 480, 720, 1080] },
              duration: record.duration || publication.duration || 0,
              aspectRatio: record.aspectRatio || publication.aspectRatio || "",
              sourceWidth: record.sourceWidth || publication.sourceWidth || 0,
              sourceHeight: record.sourceHeight || publication.sourceHeight || 0,
              updateTime: Date.now()
            })
          });
          record.firebasePublished = true;
        }
      } catch (e) {
        console.error("Mux webhook Firebase sync failed", e.message);
      }
    } else if (type === "video.asset.errored") {
      record.status = "errored";
      record.error = data?.errors || data?.error || "Mux asset processing failed";
    } else if (type === "video.upload.cancelled") {
      record.status = "cancelled";
    }
    const recordJson = JSON.stringify(record);
    await env.MEDIA_BUCKET.put(objectKey, recordJson, { httpMetadata: { contentType: "application/json" } });
    if (record.uploadId) await env.MEDIA_BUCKET.put(`${MUX_UPLOAD_PREFIX}by-upload/${record.uploadId}.json`, recordJson, { httpMetadata: { contentType: "application/json" } });
  }
  return json({ ok: true }, 200, env);
}
async function handleMuxAssetStatus(request, env, assetId) {
  let auth;
  try { auth = await verifyFirebaseToken(request, env); } catch (e) { return unauthorized(env, e.message); }
  if (!/^[a-zA-Z0-9_-]{10,200}$/.test(assetId || "")) return json({ error: "Invalid asset ID" }, 400, env);
  try {
    const result = await muxRequest(env, `/video/v1/assets/${encodeURIComponent(assetId)}`);
    const asset = result?.data;
    const recordList = await env.MEDIA_BUCKET.list({ prefix: MUX_UPLOAD_PREFIX, limit: 1000 });
    let record = null;
    for (const object of recordList.objects || []) {
      const item = await env.MEDIA_BUCKET.get(object.key);
      if (!item) continue;
      const candidate = await item.json().catch(() => null);
      if (candidate?.assetId === assetId) { record = candidate; break; }
    }
    if (record && record.ownerId !== auth.sub) return json({ error: "Asset belongs to another user" }, 403, env);
    const playback = Array.isArray(asset?.playback_ids) ? asset.playback_ids.find(item => item?.policy === "public") || asset.playback_ids[0] : null;
    const playbackId = playback?.id || record?.playbackId || "";
    return json({
      provider: "mux",
      assetId: asset?.id || assetId,
      status: asset?.status || record?.status || "preparing",
      playbackId,
      hlsUrl: muxPlaybackUrl(playbackId),
      duration: Number(asset?.duration || record?.duration || 0),
      aspectRatio: asset?.aspect_ratio || record?.aspectRatio || ""
    }, 200, env);
  } catch (e) {
    return json({ error: e?.message || "Could not read Mux asset status" }, e.status === 404 ? 404 : 503, env);
  }
}
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
async function handleMedia(request, env, key) {
  const obj = await env.MEDIA_BUCKET.get(key, { range: request.headers }); if (!obj) return new Response("Not found", { status: 404, headers: { ...corsHeaders(env), "Cache-Control": "no-store" } });
  const headers = new Headers(); obj.writeHttpMetadata(headers); headers.set("etag", obj.httpEtag); headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", key.endsWith("/master.m3u8") ? "no-store" : "public, max-age=31536000, immutable");
  if (key.endsWith(".m3u8")) headers.set("Content-Type", "application/vnd.apple.mpegurl"); else if (key.endsWith(".ts")) headers.set("Content-Type", "video/mp2t");
  Object.entries(corsHeaders(env)).forEach(([k, v]) => headers.set(k, v)); const status = obj.range ? 206 : 200;
  if (obj.range?.offset != null && obj.range?.length != null) { headers.set("Content-Range", `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`); headers.set("Content-Length", String(obj.range.length)); } else headers.set("Content-Length", String(obj.size));
  return new Response(request.method === "HEAD" ? null : obj.body, { status, headers });
}
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (url.pathname === "/api/health") return json({ ok: true, service: "flaynity-server", videoPipeline: "mux", mux: !!(env.MUX_TOKEN_ID && env.MUX_TOKEN_SECRET), time: Date.now() }, 200, env);
  if (url.pathname === "/api/v1/media/upload-url" && request.method === "POST") return handleUploadUrl(request, env);
  if (url.pathname === "/api/v1/mux/upload-url" && request.method === "POST") return handleMuxCreateUpload(request, env);
  if (url.pathname === "/api/v1/mux/webhook" && request.method === "POST") return handleMuxWebhook(request, env);
  const muxUploadStatus = url.pathname.match(/^\/api\/v1\/mux\/uploads\/([a-zA-Z0-9_-]{10,200})$/);
  if (muxUploadStatus && request.method === "GET") return handleMuxUploadStatus(request, env, muxUploadStatus[1]);
  const muxUploadCancel = url.pathname.match(/^\/api\/v1\/mux\/uploads\/([a-zA-Z0-9_-]{10,200})\/cancel$/);
  if (muxUploadCancel && request.method === "POST") return handleMuxCancelUpload(request, env, muxUploadCancel[1]);
  const muxAssetStatus = url.pathname.match(/^\/api\/v1\/mux\/assets\/([a-zA-Z0-9_-]{10,200})$/);
  if (muxAssetStatus && request.method === "GET") return handleMuxAssetStatus(request, env, muxAssetStatus[1]);
  if (url.pathname.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) { const key = decodeURIComponent(url.pathname.slice("/media/".length)); if ((!/^uploads\//.test(key)) || key.includes("..")) return new Response("Bad key", { status: 400 }); return handleMedia(request, env, key); }
  return json({ error: "Not found" }, 404, env);
} };
