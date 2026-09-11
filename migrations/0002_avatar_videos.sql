ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'audio' CHECK(kind IN ('audio','video'));
ALTER TABLE jobs ADD COLUMN source_job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE;
ALTER TABLE jobs ADD COLUMN video_tier TEXT CHECK(video_tier IN ('standard','quality'));
ALTER TABLE jobs ADD COLUMN video_meta TEXT;
ALTER TABLE jobs ADD COLUMN video_key TEXT;
ALTER TABLE jobs ADD COLUMN provider_request TEXT;
ALTER TABLE jobs ADD COLUMN submitted_at INTEGER;
CREATE INDEX jobs_source ON jobs(source_job_id);
