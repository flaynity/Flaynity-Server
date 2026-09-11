import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const app = express();
app.use(express.json({ limit: '64kb' }));
const PORT = Number(process.env.PORT || 8080);
const SECRET = String(process.env.TRANSCODER_SECRET || '');
const BUCKET = process.env.MEDIA_BUCKET_NAME || 'flaynity-storage';
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const PUBLIC_BASE = String(process.env.MEDIA_BASE_URL || 'https://cdn.flaynity.indevs.in/media').replace(/\/+$/, '');
const jobs = new Map();

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID || '', secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '' }
});

function auth(req, res, next) {
  if (!SECRET || req.get('x-flaynity-transcoder-secret') !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function safeKey(v) {
  const s = String(v || '');
  return /^uploads\/(feels|videos)\/[a-zA-Z0-9._\/-]+$/.test(s) && !s.includes('..') ? s : null;
}
function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore','pipe','pipe'] });
    let out='', err='';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => { err += d.toString(); if (err.length > 12000) err = err.slice(-12000); });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve({out, err}) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-3000)}`)));
  });
}
function publicUrl(key) { return `${PUBLIC_BASE}/${key.split('/').map(encodeURIComponent).join('/')}`; }
async function putFile(file, key, type) {
  const body = await fs.readFile(file);
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: type, CacheControl: 'public, max-age=31536000, immutable' }));
}

async function transcode(job) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), `flaynity-${job.id}-`));
  const input = path.join(work, 'input.mp4');
  const out = path.join(work, 'hls');
  await fs.mkdir(out);
  try {
    job.status='processing'; job.progress=5; job.message='Downloading original video';
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: job.sourceKey }));
    if (!obj.Body) throw new Error('R2 returned an empty video body');
    await pipeline(obj.Body, createWriteStream(input));
    job.progress=15; job.message='Encoding adaptive HLS';

    // Five rendition ladder. FFmpeg will downscale automatically when the source is smaller.
    const filter = '[0:v]split=5[v0][v1][v2][v3][v4];' +
      '[v0]scale=w=256:h=144:force_original_aspect_ratio=decrease,pad=256:144:(ow-iw)/2:(oh-ih)/2[v144];' +
      '[v1]scale=w=640:h=360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2[v360];' +
      '[v2]scale=w=854:h=480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2[v480];' +
      '[v3]scale=w=1280:h=720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v720];' +
      '[v4]scale=w=1920:h=1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[v1080]';
    const args = ['-y','-i',input,'-filter_complex',filter,
      '-map','[v144]','-map','0:a:0?','-c:v:0','libx264','-preset','veryfast','-profile:v:0','main','-b:v:0','180k','-maxrate:v:0','220k','-bufsize:v:0','360k','-g','48','-keyint_min','48','-sc_threshold','0','-c:a:0','aac','-b:a:0','48k','-ac:0','2',
      '-map','[v360]','-map','0:a:0?','-c:v:1','libx264','-preset','veryfast','-profile:v:1','main','-b:v:1','650k','-maxrate:v:1','800k','-bufsize:v:1','1300k','-c:a:1','aac','-b:a:1','64k','-ac:1','2',
      '-map','[v480]','-map','0:a:0?','-c:v:2','libx264','-preset','veryfast','-profile:v:2','main','-b:v:2','1100k','-maxrate:v:2','1350k','-bufsize:v:2','2200k','-c:a:2','aac','-b:a:2','96k','-ac:2','2',
      '-map','[v720]','-map','0:a:0?','-c:v:3','libx264','-preset','veryfast','-profile:v:3','high','-b:v:3','2500k','-maxrate:v:3','3000k','-bufsize:v:3','5000k','-c:a:3','aac','-b:a:3','128k','-ac:3','2',
      '-map','[v1080]','-map','0:a:0?','-c:v:4','libx264','-preset','veryfast','-profile:v:4','high','-b:v:4','5000k','-maxrate:v:4','6000k','-bufsize:v:4','10000k','-c:a:4','aac','-b:a:4','128k','-ac:4','2',
      '-var_stream_map','v:0,a:0,name:144p v:1,a:1,name:360p v:2,a:2,name:480p v:3,a:3,name:720p v:4,a:4,name:1080p',
      '-master_pl_name','master.m3u8','-f','hls','-hls_time','4','-hls_playlist_type','vod','-hls_segment_type','fmp4','-hls_fmp4_init_filename','init_%v.mp4','-hls_segment_filename',path.join(out,'seg_%v_%05d.m4s'),path.join(out,'v_%v.m3u8')];
    await run('ffmpeg', args, work);
    job.progress=85; job.message='Publishing HLS segments to R2';
    const files = await fs.readdir(out);
    for (const name of files) {
      const ext = path.extname(name).toLowerCase();
      const type = ext === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp4';
      await putFile(path.join(out,name), `uploads/hls/${job.id}/${name}`, type);
    }
    job.status='ready'; job.progress=100; job.message='Ready'; job.hlsUrl=publicUrl(`uploads/hls/${job.id}/master.m3u8`);
  } catch (e) {
    job.status='failed'; job.progress=0; job.message=e.message || 'Transcoding failed';
  } finally {
    await fs.rm(work, { recursive:true, force:true }).catch(()=>{});
  }
}

app.get('/health', (_req,res)=>res.json({ok:true, service:'flaynity-r2-hls-transcoder'}));
app.post('/jobs', auth, (req,res)=>{
  const sourceKey=safeKey(req.body?.sourceKey);
  if(!sourceKey) return res.status(400).json({error:'Invalid source key'});
  const id=crypto.randomUUID();
  const job={id,sourceKey,status:'queued',progress:0,message:'Queued'};
  jobs.set(id,job); transcode(job).catch(e=>{job.status='failed';job.message=e.message});
  res.status(202).json({jobId:id,status:job.status});
});
app.get('/jobs/:id', auth, (req,res)=>{
  const job=jobs.get(req.params.id); if(!job) return res.status(404).json({error:'Job not found'});
  res.json({id:job.id,status:job.status,progress:job.progress,message:job.message,hlsUrl:job.hlsUrl||null});
});
app.listen(PORT,()=>console.log(`Flaynity HLS transcoder listening on ${PORT}`));
