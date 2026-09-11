import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const app = express();
app.use(express.json({ limit: '64kb' }));

const PORT = Number(process.env.PORT || 8080);
const SECRET = String(process.env.TRANSCODER_SECRET || '');
const BUCKET = process.env.MEDIA_BUCKET_NAME || 'flaynity-storage';
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const PUBLIC_BASE = String(
  process.env.MEDIA_BASE_URL || 'https://cdn.flaynity.indevs.in/media'
).replace(/\/+$/, '');

/*
 * IMPORTANT:
 * Render Free has very little RAM. Do NOT run five FFmpeg encoders at once.
 * Jobs are queued and only one FFmpeg process is allowed to run at a time.
 */
const jobs = new Map();
let activeJob = null;
const queue = [];

const LADDER = [
  { name: '144p', height: 144, width: 256, videoBitrate: '180k', maxrate: '220k', bufsize: '360k', audio: '48k', bandwidth: 260000 },
  { name: '360p', height: 360, width: 640, videoBitrate: '650k', maxrate: '800k', bufsize: '1300k', audio: '64k', bandwidth: 800000 },
  { name: '480p', height: 480, width: 854, videoBitrate: '1100k', maxrate: '1350k', bufsize: '2200k', audio: '96k', bandwidth: 1250000 },
  { name: '720p', height: 720, width: 1280, videoBitrate: '2500k', maxrate: '3000k', bufsize: '5000k', audio: '128k', bandwidth: 2800000 },
  { name: '1080p', height: 1080, width: 1920, videoBitrate: '5000k', maxrate: '6000k', bufsize: '10000k', audio: '128k', bandwidth: 5200000 }
];

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || ''
  }
});

function auth(req, res, next) {
  if (!SECRET || req.get('x-flaynity-transcoder-secret') !== SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function safeKey(v) {
  const s = String(v || '');
  return /^uploads\/(feels|videos)\/[a-zA-Z0-9._\/-]+$/.test(s) && !s.includes('..') ? s : null;
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => {
      stdout += d.toString();
      if (stdout.length > 6000) stdout = stdout.slice(-6000);
    });

    child.stderr.on('data', d => {
      stderr += d.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });

    child.on('error', reject);

    child.on('close', code => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-3500)}`));
    });
  });
}

function runProbe(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('error', reject);

    child.on('close', code => {
      if (code === 0) return resolve(stdout.trim());
      reject(new Error(`ffprobe failed: ${stderr.slice(-1500)}`));
    });
  });
}

function publicUrl(key) {
  return `${PUBLIC_BASE}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/*
 * Stream the local segment/file directly into R2 instead of fs.readFile().
 * This prevents a large segment from being copied into Node's heap.
 */
async function putFile(file, key, type) {
  const body = createReadStream(file);

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: type,
    CacheControl: 'public, max-age=31536000, immutable'
  }));
}

async function hasAudioStream(file) {
  const out = await runProbe([
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=index',
    '-of', 'csv=p=0',
    file
  ]);
  return Boolean(out);
}

async function getVideoHeight(file) {
  const out = await runProbe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=height',
    '-of', 'csv=p=0',
    file
  ]);
  const height = Number(out);
  return Number.isFinite(height) && height > 0 ? height : 1080;
}

function selectLadder(sourceHeight) {
  /*
   * Never create fake higher-quality variants. This also saves a lot of CPU/RAM
   * for small phone videos.
   */
  return LADDER.filter(level => level.height <= Math.max(144, sourceHeight));
}

function masterPlaylist(levels, audioEnabled) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  for (const level of levels) {
    const audioPart = audioEnabled ? `,CODECS="avc1.64000d,mp4a.40.2"` : ',CODECS="avc1.64000d"';
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${level.bandwidth},AVERAGE-BANDWIDTH=${Math.round(level.bandwidth * 0.82)},RESOLUTION=${level.width}x${level.height}${audioPart}`
    );
    lines.push(`v_${level.height}p.m3u8`);
  }

  lines.push('');
  return lines.join('\n');
}

async function uploadDirectory(outDir, job) {
  const names = (await fs.readdir(outDir))
    .filter(name => name.endsWith('.m3u8') || name.endsWith('.ts'))
    .sort();

  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    const type = ext === '.m3u8'
      ? 'application/vnd.apple.mpegurl'
      : 'video/mp2t';

    await putFile(
      path.join(outDir, name),
      `uploads/hls/${job.id}/${name}`,
      type
    );

    if (job.progress < 98) {
      job.progress = Math.min(98, job.progress + Math.max(1, Math.round(4 / Math.max(1, names.length))));
    }
  }
}

async function transcode(job) {
  /*
   * One job at a time + one FFmpeg process at a time.
   * This is the key RAM protection for Render Free.
   */
  const work = await fs.mkdtemp(path.join(os.tmpdir(), `flaynity-${job.id}-`));
  const input = path.join(work, 'input.mp4');
  const out = path.join(work, 'hls');

  await fs.mkdir(out, { recursive: true });

  try {
    job.status = 'processing';
    job.progress = 3;
    job.message = 'Downloading original video';

    const obj = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: job.sourceKey
    }));

    if (!obj.Body) throw new Error('R2 returned an empty video body');

    await pipeline(obj.Body, createWriteStream(input));

    job.progress = 12;
    job.message = 'Inspecting source';

    const [audio, sourceHeight] = await Promise.all([
      hasAudioStream(input),
      getVideoHeight(input)
    ]);

    const levels = selectLadder(sourceHeight);

    if (!levels.length) {
      throw new Error('Could not determine a usable video quality.');
    }

    job.qualities = levels.map(x => x.name);
    job.message = `Preparing ${levels.map(x => x.name).join(', ')} HLS`;

    /*
     * MEMORY OPTIMIZATION:
     * Previous implementation used split=5 and encoded five variants in the
     * same FFmpeg process. That creates a large filter graph and multiple
     * encoders simultaneously.
     *
     * This version encodes ONE quality at a time. It is slower but dramatically
     * safer on a 512 MB Render instance.
     */
    for (let i = 0; i < levels.length; i++) {
      const level = levels[i];
      const playlist = path.join(out, `v_${level.height}p.m3u8`);
      const segmentPattern = path.join(out, `seg_${level.height}p_%05d.ts`);

      job.progress = 15 + Math.round((i / levels.length) * 65);
      job.message = `Encoding ${level.name}${audio ? ' + audio' : ''} (${i + 1}/${levels.length})`;

      const args = [
        '-y',
        '-hide_banner',
        '-loglevel', 'error',
        '-threads', '1',
        '-i', input,

        '-map', '0:v:0'
      ];

      if (audio) args.push('-map', '0:a:0');

      args.push(
        '-vf',
        `scale=w=${level.width}:h=${level.height}:force_original_aspect_ratio=decrease,pad=${level.width}:${level.height}:(ow-iw)/2:(oh-ih)/2`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-profile:v', level.height >= 720 ? 'high' : 'main',
        '-pix_fmt', 'yuv420p',
        '-b:v', level.videoBitrate,
        '-maxrate', level.maxrate,
        '-bufsize', level.bufsize,
        '-g', '24',
        '-keyint_min', '24',
        '-sc_threshold', '0'
      );

      if (audio) {
        args.push(
          '-c:a', 'aac',
          '-b:a', level.audio,
          '-ar', '48000',
          '-ac', '2'
        );
      }

      args.push(
        '-f', 'hls',
        '-hls_time', '1',
        '-hls_playlist_type', 'vod',
        '-hls_list_size', '0',
        '-hls_flags', 'independent_segments',
        '-hls_segment_filename', segmentPattern,
        playlist
      );

      await run('ffmpeg', args, work);

      /*
       * Free FFmpeg resources before starting the next quality.
       * spawn() exits here, so there is never a 5-encoder memory spike.
       */
    }

    const master = masterPlaylist(levels, audio);
    await fs.writeFile(path.join(out, 'master.m3u8'), master, 'utf8');

    job.progress = 82;
    job.message = 'Publishing HLS to R2';

    await uploadDirectory(out, job);

    job.status = 'ready';
    job.progress = 100;
    job.message = audio
      ? 'Ready with audio'
      : 'Ready (source had no audio track)';

    job.hlsUrl = publicUrl(`uploads/hls/${job.id}/master.m3u8`);
    job.hlsKey = `uploads/hls/${job.id}/master.m3u8`;
  } catch (e) {
    job.status = 'failed';
    job.progress = 0;
    job.message = e?.message || 'Transcoding failed';
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

async function processQueue() {
  if (activeJob || queue.length === 0) return;

  activeJob = queue.shift();

  try {
    await transcode(activeJob);
  } catch (e) {
    activeJob.status = 'failed';
    activeJob.progress = 0;
    activeJob.message = e?.message || 'Transcoding failed';
  } finally {
    activeJob = null;
    setImmediate(processQueue);
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'flaynity-r2-hls-transcoder',
    activeJob: activeJob?.id || null,
    queuedJobs: queue.length,
    memory: {
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    }
  });
});

app.post('/jobs', auth, (req, res) => {
  const sourceKey = safeKey(req.body?.sourceKey);
  if (!sourceKey) return res.status(400).json({ error: 'Invalid source key' });

  const id = crypto.randomUUID();

  const job = {
    id,
    sourceKey,
    status: 'queued',
    progress: 0,
    message: 'Queued',
    qualities: [],
    hlsUrl: null,
    hlsKey: null,
    createdAt: Date.now()
  };

  jobs.set(id, job);
  queue.push(job);
  processQueue();

  res.status(202).json({
    jobId: id,
    status: job.status,
    queuePosition: queue.length
  });
});

app.get('/jobs/:id', auth, (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    qualities: job.qualities,
    hlsUrl: job.hlsUrl || null,
    hlsKey: job.hlsKey || null,
    queuePosition: queue.indexOf(job) >= 0 ? queue.indexOf(job) + 1 : 0
  });
});

/*
 * Keep the in-memory job map bounded. Completed jobs older than one hour are
 * removed so long-running services don't grow forever.
 */
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;

  for (const [id, job] of jobs) {
    if (
      job !== activeJob &&
      job.createdAt < cutoff &&
      (job.status === 'ready' || job.status === 'failed')
    ) {
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`Flaynity HLS transcoder listening on ${PORT}`);
  console.log('Memory-safe mode: one FFmpeg process at a time');
});
