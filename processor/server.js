import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AwsClient } from "aws4fetch";

const PORT = Number(process.env.PORT || 10000);
const jobs = new Map();
const qualities = [
  { name: "144p", width: 256, height: 144, videoBitrate: "220k", maxrate: "280k", bufsize: "440k" },
  { name: "360p", width: 640, height: 360, videoBitrate: "650k", maxrate: "800k", bufsize: "1300k" },
  { name: "480p", width: 854, height: 480, videoBitrate: "1100k", maxrate: "1350k", bufsize: "2200k" },
  { name: "720p", width: 1280, height: 720, videoBitrate: "2500k", maxrate: "3000k", bufsize: "5000k" },
  { name: "1080p", width: 1920, height: 1080, videoBitrate: "5000k", maxrate: "6000k", bufsize: "10000k" }
];
function json(res, code, data) { const body = JSON.stringify(data); res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(body); }
function authorized(req) { const expected = process.env.FFMPEG_PROCESSOR_TOKEN || ""; return !expected || req.headers["x-flaynity-job-token"] === expected; }
function parse(req) { return new Promise((resolve, reject) => { let s = ""; req.on("data", c => { s += c; if (s.length > 1000000) req.destroy(); }); req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch (e) { reject(e); } }); req.on("error", reject); }); }
function run(cmd, args, cwd) { return new Promise((resolve, reject) => { const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; p.stdout.on("data", d => { stdout += d.toString(); if (stdout.length > 20000) stdout = stdout.slice(-20000); }); p.stderr.on("data", d => { stderr += d.toString(); if (stderr.length > 12000) stderr = stderr.slice(-12000); }); p.on("error", reject); p.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-4000)}`))); }); }
function masterPlaylist(available, dimensions) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-INDEPENDENT-SEGMENTS"];
  for (const q of qualities) {
    if (!available.has(q.name)) continue;
    const d = dimensions[q.name] || { width: q.width, height: q.height };
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${Math.round(parseInt(q.videoBitrate) * 1.35)},AVERAGE-BANDWIDTH=${parseInt(q.videoBitrate)},RESOLUTION=${d.width}x${d.height}`, `${q.name}/index.m3u8`);
  }
  return `${lines.join("\n")}\n`;
}
function probeVideo(sourceUrl) {
  return run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", sourceUrl], os.tmpdir()).then(({ stdout }) => {
    const stream = JSON.parse(stdout || "{}").streams?.[0] || {};
    const width = Number(stream.width), height = Number(stream.height);
    if (!width || !height) throw new Error("Could not determine the original video dimensions.");
    return { width, height };
  });
}
function fitDimensions(sourceWidth, sourceHeight, q) {
  const ratio = sourceWidth / sourceHeight;
  let width, height;
  if (ratio >= 1) {
    height = Math.min(q.height, sourceHeight);
    width = Math.round(height * ratio);
    if (width > q.width) { width = Math.min(q.width, sourceWidth); height = Math.round(width / ratio); }
  } else {
    width = Math.min(q.height, sourceWidth);
    height = Math.round(width / ratio);
    if (height > q.height) { height = Math.min(q.height, sourceHeight); width = Math.round(height * ratio); }
  }
  width = Math.max(2, width - (width % 2));
  height = Math.max(2, height - (height % 2));
  return { width, height };
}
async function s3Put(key, body, contentType) {
  const account = process.env.R2_ACCOUNT_ID; const bucket = process.env.MEDIA_BUCKET_NAME || "flaynity-storage";
  const client = new AwsClient({ accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
  const url = `https://${account}.r2.cloudflarestorage.com/${bucket}/${key}`;
  const r = await client.fetch(url, { method: "PUT", headers: { "Content-Type": contentType, "Cache-Control": key.endsWith(".m3u8") ? "public, max-age=60" : "public, max-age=31536000, immutable" }, body });
  if (!r.ok) throw new Error(`R2 upload failed ${r.status}: ${await r.text()}`);
}
async function uploadTree(dir, prefix) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries.filter(e => !e.isDirectory());
  const dirs = entries.filter(e => e.isDirectory());
  // Upload small HLS files concurrently to reduce publish latency without creating a huge memory spike.
  const concurrency = 4;
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    await Promise.all(batch.map(async e => {
      const full = path.join(dir, e.name);
      const key = `${prefix}/${e.name}`;
      await s3Put(key, await fs.readFile(full), e.name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t");
    }));
  }
  for (const e of dirs) await uploadTree(path.join(dir, e.name), `${prefix}/${e.name}`);
}
async function processJob(job) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `flaynity-${job.jobId}-`));
  try {
    job.status = "processing"; job.progress = 0; job.available = []; job.phase = "preparing-144p";
    const source = await probeVideo(job.sourceUrl);
    job.sourceWidth = source.width; job.sourceHeight = source.height;
    job.aspectRatio = source.width / source.height;
    const available = new Set();
    const dimensions = {};
    const hlsPrefix = `uploads/hls/${job.jobId}`;
    await fs.mkdir(path.join(root, "144p"), { recursive: true });
    for (let i = 0; i < qualities.length; i++) {
      const q = qualities[i];
      const d = fitDimensions(source.width, source.height, q);
      dimensions[q.name] = d;
      job.currentQuality = q.name;
      job.currentWidth = d.width; job.currentHeight = d.height;
      job.phase = i === 0 ? "encoding-144p" : `encoding-${q.name}`;
      await fs.mkdir(path.join(root, q.name), { recursive: true });
      const isFirst = i === 0;
      const args = ["-hide_banner", "-loglevel", "error", "-i", job.sourceUrl, "-map", "0:v:0", "-map", "0:a:0?", "-threads", isFirst ? "2" : "2", "-vf", `scale=w=${d.width}:h=${d.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`, "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "main", "-b:v", q.videoBitrate, "-maxrate", q.maxrate, "-bufsize", q.bufsize, "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-ar", "48000", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod", "-hls_flags", "independent_segments", "-hls_segment_filename", path.join(root, q.name, "seg_%05d.ts"), path.join(root, q.name, "index.m3u8")];
      await run("ffmpeg", args, root);
      available.add(q.name); job.available = [...available]; job.progress = Math.round(((i + 1) / qualities.length) * 100);
      job.phase = i === 0 ? "publishing-144p" : `publishing-${q.name}`;
      await uploadTree(path.join(root, q.name), `${hlsPrefix}/${q.name}`);
      await s3Put(`${hlsPrefix}/master.m3u8`, masterPlaylist(available, dimensions), "application/vnd.apple.mpegurl");
      if (i === 0) {
        job.status = "ready-144p";
        job.readyAt = Date.now();
      }
    }
    job.status = "ready"; job.phase = "completed"; job.currentQuality = null; job.finishedAt = Date.now();
  } catch (e) { job.status = "failed"; job.error = e.message || String(e); job.currentQuality = null; }
  finally { await fs.rm(root, { recursive: true, force: true }).catch(() => {}); }
  return job;
}
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true, service: "flaynity-ffmpeg-processor", ffmpeg: true });
  if (!authorized(req)) return json(res, 401, { error: "Unauthorized processor request" });
  if (req.method === "POST" && req.url === "/process") {
    try { const b = await parse(req); if (!b.jobId || !b.sourceUrl) return json(res, 400, { error: "jobId and sourceUrl are required" }); if (jobs.has(b.jobId)) return json(res, 200, jobs.get(b.jobId)); const job = { jobId: b.jobId, sourceKey: b.sourceKey || null, status: "queued", progress: 0, available: [], createdAt: Date.now() }; jobs.set(b.jobId, job); processJob(job).catch(e => { job.status = "failed"; job.error = e.message || String(e); }); return json(res, 202, job); } catch (e) { return json(res, 400, { error: e.message || "Invalid JSON" }); }
  }
  if (req.method === "GET" && req.url.startsWith("/jobs/")) { const id = decodeURIComponent(req.url.slice(6)); const job = jobs.get(id); return job ? json(res, 200, job) : json(res, 404, { error: "Job not found" }); }
  return json(res, 404, { error: "Not found" });
});
server.listen(PORT, "0.0.0.0", () => console.log(`Flaynity FFmpeg processor listening on ${PORT}`));
