import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";

const jobs = new Map();
// Render Free/low-memory instances must never run multiple FFmpeg encodes at
// the same time. Queue initial and background jobs globally.
const queued = new Set();
let activeJobId = null;
const queue = [];
export const qualities = [
  { name: "360p", width: 640, height: 360, videoBitrate: "650k", maxrate: "800k", bufsize: "1300k" },
  { name: "480p", width: 854, height: 480, videoBitrate: "1100k", maxrate: "1350k", bufsize: "2200k" },
  { name: "720p", width: 1280, height: 720, videoBitrate: "2500k", maxrate: "3000k", bufsize: "5000k" },
  { name: "1080p", width: 1920, height: 1080, videoBitrate: "5000k", maxrate: "6000k", bufsize: "10000k" }
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function json(res, code, data) { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(data)); }
function authorized(req) { const token = process.env.FFMPEG_PROCESSOR_TOKEN; return !!token && req.headers["x-flaynity-job-token"] === token; }
async function parse(req) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > 1000000) throw new Error("Request too large"); }
  return JSON.parse(body || "{}");
}
export function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout = (stdout + d).slice(-1000000); });
    child.stderr.on("data", d => { stderr = (stderr + d).slice(-12000); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-4000)}`)));
  });
}
export function sourceGeometry(stream) {
  const width = Number(stream.width), height = Number(stream.height);
  const [sn, sd] = String(stream.sample_aspect_ratio || "1:1").split(":").map(Number);
  const sar = sn > 0 && sd > 0 ? sn / sd : 1;
  const rotation = Number(stream.side_data_list?.find(s => s.rotation != null)?.rotation ?? stream.tags?.rotate ?? 0);
  const radians = rotation * Math.PI / 180;
  // FFmpeg autorotates the decoded frame. Include non-square pixels in DAR.
  const displayWidth = Math.abs(width * sar * Math.cos(radians)) + Math.abs(height * Math.sin(radians));
  const displayHeight = Math.abs(width * sar * Math.sin(radians)) + Math.abs(height * Math.cos(radians));
  if (!(displayWidth > 0 && displayHeight > 0)) throw new Error("Video has no valid dimensions");
  return { width: Math.round(displayWidth), height: Math.round(displayHeight), aspectRatio: displayWidth / displayHeight };
}
export function renditionGeometry(source, quality) {
  const ratio = source.aspectRatio;
  const portrait = ratio < 1;
  const maxWidth = portrait ? quality.height : quality.width;
  const maxHeight = portrait ? quality.width : quality.height;
  const height = Math.min(maxHeight, maxWidth / ratio);
  return { width: Math.max(2, Math.round(height * ratio / 2) * 2), height: Math.max(2, Math.round(height / 2) * 2) };
}
export function masterPlaylist(renditions, hasAudio = true) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"];
  for (const q of qualities) {
    const size = renditions[q.name];
    if (!size) continue;
    const audio = hasAudio ? 96000 : 0;
    const average = parseInt(q.videoBitrate, 10) * 1000 + audio;
    const peak = Math.ceil((parseInt(q.maxrate, 10) * 1000 + audio) * 1.1);
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${peak},AVERAGE-BANDWIDTH=${average},RESOLUTION=${size.width}x${size.height}`, `${q.name}/index.m3u8`);
  }
  return `${lines.join("\n")}\n`;
}
async function s3Request(key, options = {}) {
  const bucket = process.env.MEDIA_BUCKET_NAME || "flaynity-storage";
  const client = new AwsClient({ accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  return client.fetch(`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucket}/${key}`, options);
}
async function s3Put(key, body, contentType) {
  const mutable = key.endsWith("/master.m3u8") || key.startsWith("internal/");
  const response = await s3Request(key, { method: "PUT", headers: { "Content-Type": contentType, "Cache-Control": mutable ? "no-store" : "public, max-age=31536000, immutable" }, body });
  if (!response.ok) throw new Error(`R2 upload failed (${response.status})`);
}
async function saveJob(job) { await s3Put(`internal/processor/${job.jobId}.json`, JSON.stringify(job), "application/json"); }
async function getJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  const response = await s3Request(`internal/processor/${id}.json`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Cannot restore job (${response.status})`);
  const restored = await response.json();
  if (jobs.has(id)) return jobs.get(id);
  jobs.set(id, restored); return restored;
}
async function uploadTree(dir, prefix) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  // Publish every segment BEFORE exposing the variant playlist.
  entries.sort((a, b) => Number(a.name.endsWith(".m3u8")) - Number(b.name.endsWith(".m3u8")));
  for (const e of entries) {
    const full = path.join(dir, e.name), key = `${prefix}/${e.name}`;
    if (e.isDirectory()) await uploadTree(full, key);
    else await s3Put(key, await fs.readFile(full), e.name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
  }
}
async function prepare(root, job) {
  const response = await fetch(job.sourceUrl);
  if (!response.ok || !response.body) throw new Error(`Source download failed (${response.status})`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path.join(root, "source")));
  const info = JSON.parse(await run("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path.join(root, "source")], root));
  const stream = info.streams.find(s => s.codec_type === "video");
  if (!stream) throw new Error("Source has no video stream");
  job.source = { ...sourceGeometry(stream), duration: Number(info.format?.duration) || 0, hasAudio: info.streams.some(s => s.codec_type === "audio") };
}
export async function encode(root, job, q) {
  const size = renditionGeometry(job.source, q);
  await fs.mkdir(path.join(root, q.name), { recursive: true });
  // The rendition dimensions are already calculated from the source display
  // aspect ratio. Encode with square pixels (SAR 1:1) so HLS.js/native players
  // see the real coded width/height instead of relying on a non-square SAR.
  // This preserves arbitrary portrait, landscape and square uploads.
  const filter = `scale=${size.width}:${size.height}:force_original_aspect_ratio=disable,setsar=1,fps=24,setpts=PTS-STARTPTS`;
  await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", path.join(root, "source"), "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-vf", filter, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", q.name === "360p" ? "ultrafast" : "veryfast", "-threads", "2", "-profile:v", "main", "-b:v", q.videoBitrate, "-maxrate", q.maxrate, "-bufsize", q.bufsize, "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-force_key_frames", "expr:gte(t,n_forced*2)", "-metadata:s:v:0", "rotate=0", "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-ar", "48000", "-af", "aresample=async=1:first_pts=0", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_flags", "independent_segments", "-hls_segment_filename", path.join(root, q.name, "seg_%05d.ts"), path.join(root, q.name, "index.m3u8")], root);
  return size;
}
async function notify(job) {
  if (!job.publishedAt || !job.callbackUrl) return;
  let error;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(job.callbackUrl, { method: "POST", headers: { "content-type": "application/json", "x-flaynity-job-token": process.env.FFMPEG_PROCESSOR_TOKEN || "" }, body: JSON.stringify({ jobId: job.jobId }), signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`Firebase sync failed (${response.status})`);
      delete job.syncError; return;
    } catch (e) { error = e; await sleep(1000 * (attempt + 1)); }
  }
  // Encoding remains usable; the Worker's scheduled reconciliation retries sync.
  job.syncError = error.message; await saveJob(job);
}
const defaultIO = { prepare, encode, upload: uploadTree, put: s3Put, save: saveJob, notify };
export async function processStage(job, background = false, io = defaultIO) {
  if (background && (!job.publishedAt || !job.available.includes("360p"))) throw new Error("Firebase publication must be confirmed before background encoding");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flaynity-"));
  try {
    job.status = background ? "processing-background" : "processing";
    delete job.error;
    await io.prepare(root, job);
    const ladder = background ? qualities.slice(1) : qualities.slice(0, 1);
    for (const q of ladder) {
      if (job.available.includes(q.name)) continue;
      job.currentQuality = q.name;
      await io.save(job);
      const size = await io.encode(root, job, q);
      const prefix = `uploads/hls/${job.jobId}`;
      await io.upload(path.join(root, q.name), `${prefix}/${q.name}`);
      const next = { ...job.renditions, [q.name]: size };
      const manifest = masterPlaylist(next, job.source.hasAudio);
      const version = Object.keys(next).length;
      await io.put(`${prefix}/master-v${version}.m3u8`, manifest, "application/vnd.apple.mpegurl");
      await io.put(`${prefix}/master.m3u8`, manifest, "application/vnd.apple.mpegurl");
      // Only advertise a quality after BOTH playlists and all segments exist.
      job.renditions = next; job.available = qualities.filter(q => next[q.name]).map(q => q.name);
      job.manifestVersion = version; job.progress = Math.round(version / qualities.length * 100);
      job.currentQuality = null;
      job.status = !background ? "ready-360p" : version === qualities.length ? "ready" : "processing-background";
      if (job.status === "ready") job.finishedAt = Date.now();
      await io.save(job);
      await io.notify(job);
    }
  } catch (e) {
    job.status = job.available.includes("360p") ? "ready-partial" : "failed";
    job.error = e.message || String(e); job.currentQuality = null;
    await io.save(job);
    await io.notify(job);
  } finally { await fs.rm(root, { recursive: true, force: true }).catch(() => {}); }
  return job;
}
function kick(job, background) {
  const key = `${job.jobId}:${background ? "background" : "initial"}`;
  if (activeJobId === job.jobId || queued.has(key)) return;
  queued.add(key);
  queue.push({ job, background, key });
  pumpQueue();
}

async function pumpQueue() {
  if (activeJobId || !queue.length) return;
  const item = queue.shift();
  queued.delete(item.key);
  activeJobId = item.job.jobId;
  try {
    await processStage(item.job, item.background);
  } catch (e) {
    console.error("Job persistence error", item.job.jobId, e.message);
  } finally {
    activeJobId = null;
    if (!item.background && item.job.publishedAt && item.job.status === "ready-360p") {
      kick(item.job, true);
    }
    void pumpQueue();
  }
}
export const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true, service: "flaynity-ffmpeg-processor", ffmpeg: true });
  if (!authorized(req)) return json(res, 401, { error: "Unauthorized processor request" });
  try {
    if (req.method === "POST" && req.url === "/process") {
      const b = await parse(req);
      if (!/^[a-f0-9-]{20,80}$/i.test(b.jobId || "") || !b.sourceUrl || !b.ownerId || !b.publicationPath || !b.callbackUrl) return json(res, 400, { error: "Missing job source or publication information" });
      let job = await getJob(b.jobId);
      job = jobs.get(b.jobId) || job;
      if (!job) {
        job = { jobId: b.jobId, sourceKey: b.sourceKey, sourceUrl: b.sourceUrl, ownerId: b.ownerId, publicationPath: b.publicationPath, callbackUrl: b.callbackUrl, status: "queued", progress: 0, available: [], renditions: {}, manifestVersion: 0, createdAt: Date.now() };
        jobs.set(job.jobId, job);
        await saveJob(job);
      }
      // A new /process request explicitly retries a failed first rendition.
      if (!job.available.includes("360p")) kick(job, false);
      return json(res, 202, job);
    }
    const match = req.url.match(/^\/jobs\/([a-f0-9-]{20,80})(\/published)?$/i);
    if (match) {
      const job = await getJob(match[1]);
      if (!job) return json(res, 404, { error: "Job not found" });
      if (req.method === "POST" && match[2]) {
        if (!job.available.includes("360p")) return json(res, 409, { error: "360p is not ready" });
        job.publishedAt ||= Date.now();
        await saveJob(job);
        if (job.available.length < qualities.length) kick(job, true);
        return json(res, 202, job);
      }
      if (req.method === "GET" && !match[2]) {
        // Resume a job restored from R2 after a Render restart.
        if (job.publishedAt && job.available.length < qualities.length && job.status !== "ready-partial") kick(job, true);
        else if (!job.available.length && job.status !== "failed") kick(job, false);
        return json(res, 200, job);
      }
    }
    return json(res, 404, { error: "Not found" });
  } catch (e) { return json(res, 500, { error: e.message || "Processor request failed" }); }
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(Number(process.env.PORT || 10000), "0.0.0.0", () => console.log("Flaynity FFmpeg processor listening"));
}
