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
const PUBLIC_BASE = String(process.env.MEDIA_BASE_URL || 'https://cdn.flaynity.indevs.in/media').replace(/\/+$/, '');
const jobs = new Map();
const queue = [];
let activeJob = null;

const LADDER = [
  { name: '144p', width: 256, height: 144, v: '180k', max: '220k', buf: '360k', a: '48k', profile: 'main', bandwidth: 260000 },
  { name: '360p', width: 640, height: 360, v: '650k', max: '800k', buf: '1300k', a: '64k', profile: 'main', bandwidth: 760000 },
  { name: '480p', width: 854, height: 480, v: '1100k', max: '1350k', buf: '2200k', a: '96k', profile: 'main', bandwidth: 1250000 },
  { name: '720p', width: 1280, height: 720, v: '2500k', max: '3000k', buf: '5000k', a: '128k', profile: 'high', bandwidth: 2800000 },
  { name: '1080p', width: 1920, height: 1080, v: '5000k', max: '6000k', buf: '10000k', a: '128k', profile: 'high', bandwidth: 5400000 }
];

const s3 = new S3Client({
  region: 'auto', endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
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
function run(cmd, args, cwd, job) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FFREPORT: 'level=error' } });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString(); if (out.length > 4000) out = out.slice(-4000); });
    p.stderr.on('data', d => {
      err += d.toString(); if (err.length > 12000) err = err.slice(-12000);
      if (job && /frame=|time=/.test(d.toString())) job.progress = Math.max(job.progress || 0, Math.min(80, (job.qualityIndex || 0) * 14 + 18));
    });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-3000)}`)));
  });
}
function publicUrl(key) { return `${PUBLIC_BASE}/${key.split('/').map(encodeURIComponent).join('/')}`; }
async function putFile(file, key, type, cacheControl = 'public, max-age=31536000, immutable') {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: createReadStream(file), ContentType: type, CacheControl: cacheControl }));
}
async function hasAudioStream(file) {
  return await new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v','error','-select_streams','a:0','-show_entries','stream=index','-of','csv=p=0',file], {stdio:['ignore','pipe','pipe']});
    let out='', err=''; p.stdout.on('data',d=>out+=d.toString()); p.stderr.on('data',d=>err+=d.toString()); p.on('error',reject);
    p.on('close',code=>code===0?resolve(Boolean(out.trim())):reject(new Error(`ffprobe failed: ${err.slice(-1000)}`)));
  });
}
async function probeVideoDimensions(file) {
  return await new Promise((resolve,reject)=>{
    const p=spawn('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','csv=p=0:s=x',file],{stdio:['ignore','pipe','pipe']});
    let out='',err=''; p.stdout.on('data',d=>out+=d.toString()); p.stderr.on('data',d=>err+=d.toString()); p.on('error',reject);
    p.on('close',code=>{if(code!==0)return reject(new Error(`ffprobe video dimensions failed: ${err.slice(-1000)}`)); const m=out.trim().match(/^(\d+)x(\d+)$/); if(!m)return reject(new Error('Could not detect original video dimensions.')); resolve({width:Number(m[1]),height:Number(m[2])});});
  });
}
function fitDimensions(srcW,srcH,maxW,maxH){const scale=Math.min(maxW/srcW,maxH/srcH,1);return{width:Math.max(2,Math.round(srcW*scale/2)*2),height:Math.max(2,Math.round(srcH*scale/2)*2)};}
async function uploadDirectory(dir,prefix){
  const names=(await fs.readdir(dir)).filter(name=>name.endsWith('.m3u8')||name.endsWith('.ts'));
  // R2 uploads are independent objects, so use more parallelism here. This is
  // especially important for the first 144p rendition: publish it as soon as
  // its segments are in R2 instead of serially uploading each segment.
  const concurrency=8; let cursor=0;
  async function worker(){while(true){const i=cursor++;if(i>=names.length)return;const name=names[i];const ext=path.extname(name).toLowerCase();await putFile(path.join(dir,name),`${prefix}/${name}`,ext==='.m3u8'?'application/vnd.apple.mpegurl':'video/mp2t');}}
  await Promise.all(Array.from({length:Math.min(concurrency,names.length)},worker));
}
function makeMaster(variants,audio){const lines=['#EXTM3U','#EXT-X-VERSION:3'];for(const v of variants){lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},AVERAGE-BANDWIDTH=${Math.round(v.bandwidth*.9)},RESOLUTION=${v.width}x${v.height},CODECS=\"${audio?'avc1.4d401f,mp4a.40.2':'avc1.4d401f'}\"`);lines.push(`${v.name}/index.m3u8`);}return `${lines.join('\n')}\n`;}

async function publishMaster(job,hlsRoot,variants,audio){
  const file=path.join(hlsRoot,'master.m3u8');
  await fs.writeFile(file,makeMaster(variants,audio),'utf8');
  await putFile(file,`uploads/hls/${job.id}/master.m3u8`,'application/vnd.apple.mpegurl','public, max-age=5, must-revalidate');
  job.hlsUrl=publicUrl(`uploads/hls/${job.id}/master.m3u8`);
  job.hlsKey=`uploads/hls/${job.id}/master.m3u8`;
  job.videoQualities=variants.map(v=>({quality:v.name,url:publicUrl(`uploads/hls/${job.id}/${v.name}/index.m3u8`)}));
}

async function transcode(job){
  const work=await fs.mkdtemp(path.join(os.tmpdir(),`flaynity-${job.id}-`));
  const input=path.join(work,'input.mp4'); const hlsRoot=path.join(work,'hls'); await fs.mkdir(hlsRoot);
  try{
    job.status='processing'; job.progress=3; job.message='Downloading original video';
    const obj=await s3.send(new GetObjectCommand({Bucket:BUCKET,Key:job.sourceKey})); if(!obj.Body)throw new Error('R2 returned an empty video body'); await pipeline(obj.Body,createWriteStream(input));
    job.progress=10; const audio=await hasAudioStream(input); const sourceSize=await probeVideoDimensions(input); job.hasAudio=audio; job.sourceWidth=sourceSize.width; job.sourceHeight=sourceSize.height;
    const variants=[];
    for(let i=0;i<LADDER.length;i++){
      const base=LADDER[i],dims=fitDimensions(sourceSize.width,sourceSize.height,base.width,base.height),q={...base,width:dims.width,height:dims.height};
      job.qualityIndex=i; job.message=`Encoding ${q.name}${audio?' + audio':''} (${i+1}/${LADDER.length})`; job.progress=12+Math.round((i/LADDER.length)*65);
      const dir=path.join(hlsRoot,q.name); await fs.mkdir(dir);
      // The first playable rendition is optimized for time-to-first-playback.
      // Higher renditions keep the normal quality-oriented encoder settings.
      const preset = i === 0 ? 'ultrafast' : 'superfast';
      const threads = i === 0 ? '2' : '1';
      const args=['-y','-hide_banner','-loglevel','error','-i',input,'-map','0:v:0',...(audio?['-map','0:a:0?']:[]),'-vf',`scale=w=${q.width}:h=${q.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`,'-c:v','libx264','-preset',preset,'-threads',threads,'-profile:v',q.profile,'-pix_fmt','yuv420p','-b:v',q.v,'-maxrate',q.max,'-bufsize',q.buf,'-g','120','-keyint_min','120','-force_key_frames','expr:gte(t,n_forced*2)','-sc_threshold','0'];
      if(audio)args.push('-c:a','aac','-b:a',q.a,'-ar','48000','-ac','2');
      args.push('-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_list_size','0','-hls_flags','independent_segments','-hls_segment_filename',path.join(dir,'seg_%05d.ts'),path.join(dir,'index.m3u8'));
      await run('ffmpeg',args,work,job); variants.push(q);
      await uploadDirectory(dir,`uploads/hls/${job.id}/${q.name}`);
      await publishMaster(job,hlsRoot,variants,audio);
      job.message=i===0?'144p ready — higher qualities are processing':`${q.name} ready`;
      job.progress=i===0?28:12+Math.round(((i+1)/LADDER.length)*70);
      // IMPORTANT: once 144p is published, the upload is considered ready.
      // FFmpeg continues the remaining qualities in the same background job.
      // This makes the UI return immediately after the first playable rendition.
      if (i === 0) {
        job.status = 'ready';
        job.initialReady = true;
        job.progress = 28;
      }
    }
    job.status='ready'; job.progress=100; job.message=audio?'Ready with adaptive HLS':'Ready (source has no audio track)';
  }catch(e){
    // If 144p was already published, keep the job playable even when a later
    // high-quality rendition fails. The available ladder remains usable.
    if (job.initialReady && job.hlsUrl) {
      job.status='ready';
      job.message='144p ready; some higher qualities failed to process';
    } else {
      job.status='failed'; job.progress=0; job.message=e?.message||'Transcoding failed';
    }
  }finally{await fs.rm(work,{recursive:true,force:true}).catch(()=>{});}
}
async function pumpQueue(){if(activeJob||!queue.length)return;activeJob=queue.shift();try{await transcode(activeJob);}catch(e){if(activeJob.initialReady&&activeJob.hlsUrl){activeJob.status='ready';activeJob.message='144p ready; background processing incomplete';}else{activeJob.status='failed';activeJob.progress=0;activeJob.message=e?.message||'Transcoding failed';}}finally{activeJob=null;const now=Date.now();for(const[id,job]of jobs){if(job.status!=='queued'&&job.status!=='processing'&&now-job.createdAt>60*60*1000)jobs.delete(id);}setImmediate(pumpQueue);}}

app.get('/health',(_req,res)=>res.json({ok:true,service:'flaynity-r2-hls-transcoder',queue:queue.length,processing:Boolean(activeJob),memory:process.memoryUsage().rss}));
app.post('/jobs',auth,(req,res)=>{const sourceKey=safeKey(req.body?.sourceKey);if(!sourceKey)return res.status(400).json({error:'Invalid source key'});const id=crypto.randomUUID();const job={id,sourceKey,status:'queued',progress:0,message:'Queued (fast 144p first, then adaptive qualities)',createdAt:Date.now(),hlsUrl:null,hlsKey:null,hasAudio:null,videoQualities:[],initialReady:false};jobs.set(id,job);queue.push(job);pumpQueue();res.status(202).json({jobId:id,status:job.status,message:job.message});});
app.get('/jobs/:id',auth,(req,res)=>{const job=jobs.get(req.params.id);if(!job)return res.status(404).json({error:'Job not found'});res.json({id:job.id,status:job.status,progress:job.progress,message:job.message,hlsUrl:job.hlsUrl||null,hlsKey:job.hlsKey||null,hasAudio:job.hasAudio,videoQualities:job.videoQualities||[]});});
app.listen(PORT,()=>console.log(`Flaynity HLS transcoder listening on ${PORT} (144p-first adaptive mode, 2s HLS segments)`));
