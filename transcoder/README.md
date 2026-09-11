# Flaynity R2 HLS Transcoder (Stream-free)

This service is the FFmpeg compute layer. The Cloudflare Worker remains the secure API/control layer and R2 remains the media store.

## Flow
1. App uploads original MP4 to R2 using the Worker-issued presigned PUT URL.
2. App asks the Worker to create an HLS transcode job.
3. Worker authenticates Firebase and forwards the job to this service with `TRANSCODER_SECRET`.
4. This service downloads the original from R2, creates 144p/360p/480p/720p/1080p HLS/fMP4 renditions, and uploads the manifest/segments back to R2 under `uploads/hls/<jobId>/`.
5. App polls job status and publishes the HLS master URL.

## Deploy
Deploy this directory as a Docker service (Render/Fly.io/Railway/VPS are suitable). FFmpeg is installed by the included Dockerfile.

Set the environment variables from `.env.example`.

On the Cloudflare Worker, set:
- `TRANSCODER_URL=https://YOUR-TRANSCODER-HOST`
- secret `TRANSCODER_SECRET` to the exact same random value
- keep the existing `MEDIA_BUCKET` binding and R2 variables

Do not expose R2 access keys in the frontend.

## Important
The Worker itself cannot run FFmpeg. A compute service is required for transcoding. This is still completely independent of Cloudflare Stream and does not call the Stream API.
