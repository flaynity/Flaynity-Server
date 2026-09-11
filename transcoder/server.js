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

async function hasAudioStream(file) {
  return await new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v','error','-select_streams','a:0','-show_entries','stream=index','-of','csv=p=0',file], { stdio:['ignore','pipe','pipe'] });
    let out=''; let err='';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve(Boolean(out.trim())) : reject(new Error(`ffprobe failed: ${err.slice(-1000)}`)));
  });
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
    job.progress=15; job.message='Preparing adaptive HLS';

    const audio = await hasAudioStream(input);
    // Ascending ladder is intentional: level 0 is always the lowest quality,
    // allowing the player to start tiny and hand control to ABR after startup.
    const filter = '[0:v]split=5[v0][v1][v2][v3][v4];' +
      '[v0]scale=w=256:h=144:force_original_aspect_ratio=decrease,pad=256:144:(ow-iw)/2:(oh-ih)/2[v144];' +
      '[v1]scale=w=640:h=360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2[v360];' +
      '[v2]scale=w=854:h=480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2[v480];' +
      '[v3]scale=w=1280:h=720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v720];' +
      '[v4]scale=w=1920:h=1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[v1080]';

    const args = ['-y','-i',input,'-filter_complex',filter];
    const videoMaps = [
      ['[v144]','180k','220k','360k','48k','main'],
      ['[v360]','650k','800k','1300k','64k','main'],
      ['[v480]','1100k','1350k','2200k','96k','main'],
      ['[v720]','2500k','3000k','5000k','128k','high'],
      ['[v1080]','5000k','6000k','10000k','128k','high']
    ];
    videoMaps.forEach((m,i) => {
      args.push('-map',m[0]);
      if (audio) args.push('-map','0:a:0');
      args.push('-c:v:'+i,'libx264','-preset','veryfast','-profile:v:'+i,m[5],'-pix_fmt:v:'+i,'yuv420p',
        '-b:v:'+i,m[1],'-maxrate:v:'+i,m[2],'-bufsize:v:'+i,m[3],
        '-g:v:'+i,'24','-keyint_min:v:'+i,'24','-sc_threshold:v:'+i,'0');
      if (audio) args.push('-c:a:'+i,'aac','-b:a:'+i,m[4],'-ar:'+i,'48000','-ac:'+i,'2');
    });

    const map = audio
      ? 'v:0,a:0,name:144p v:1,a:1,name:360p v:2,a:2,name:480p v:3,a:3,name:720p v:4,a:4,name:1080p'
      : 'v:0,name:144p v:1,name:360p v:2,name:480p v:3,name:720p v:4,name:1080p';

    args.push('-var_stream_map',map,
      '-master_pl_name','master.m3u8',
      '-f','hls',
      '-hls_time','1',
      '-hls_playlist_type','vod',
      '-hls_list_size','0',
      '-hls_flags','independent_segments',
      '-hls_segment_filename',path.join(out,'seg_%v_%05d.ts'),
      path.join(out,'v_%v.m3u8'));

    job.message = audio ? 'Encoding video + AAC audio' : 'Encoding video (no audio track found)';
    await run('ffmpeg', args, work);
    job.progress=85; job.message='Publishing HLS segments to R2';
    const files = await fs.readdir(out);
    for (const name of files) {
      const ext = path.extname(name).toLowerCase();
      const type = ext === '.m3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
      await putFile(path.join(out,name), `uploads/hls/${job.id}/${name}`, type);
    }
    job.status='ready'; job.progress=100; job.message=audio ? 'Ready with audio' : 'Ready (source had no audio)';
    job.hlsUrl=publicUrl(`uploads/hls/${job.id}/master.m3u8`);
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
