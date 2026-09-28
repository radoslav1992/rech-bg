-- Plan that granted each usage window, so a mid-period downgrade lowers the quota instead of keeping the higher one.
ALTER TABLE usage_windows ADD COLUMN plan TEXT;
-- Trial usage of deleted accounts, keyed by a hash of the email, so re-registering does not grant a fresh trial.
CREATE TABLE IF NOT EXISTS trial_history (email_hash TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0);
-- Latest job per project (project list), project deletion and the jobs.project_id foreign-key cascade.
CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id,created_at DESC);
-- Hourly reconciliation of stuck and finished jobs.
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,updated_at);
-- Storage release for a failed job.
CREATE INDEX IF NOT EXISTS media_assets_job ON media_assets(job_id);
-- Token cleanup after password changes and resets.
CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens(user_id);
-- Finished jobs whose leftover segments the hourly backstop already removed, so it moves on to older ones.
CREATE TABLE IF NOT EXISTS segment_sweeps (job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE);
