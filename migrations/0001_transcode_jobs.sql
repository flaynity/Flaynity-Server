CREATE TABLE IF NOT EXISTS transcode_jobs (
  job_id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  error TEXT,
  video_provider TEXT,
  video_url TEXT,
  video_link TEXT,
  hls_url TEXT,
  output_prefix TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_transcode_jobs_queue ON transcode_jobs(status, created_at);
