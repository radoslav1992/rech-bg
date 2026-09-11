PRAGMA foreign_keys = ON;
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, stripe_customer TEXT UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE auth_tokens (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,kind TEXT NOT NULL CHECK(kind IN ('verify','reset')),expires_at INTEGER NOT NULL);
CREATE TABLE projects (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,mode TEXT NOT NULL,script TEXT NOT NULL,voice TEXT NOT NULL,second_voice TEXT NOT NULL,pause_ms INTEGER NOT NULL DEFAULT 400,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX projects_user ON projects(user_id,updated_at DESC);
CREATE TABLE subscriptions (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,plan TEXT NOT NULL,status TEXT NOT NULL,period_start INTEGER NOT NULL,period_end INTEGER NOT NULL,cancel_at_period_end INTEGER NOT NULL DEFAULT 0,event_created INTEGER NOT NULL DEFAULT 0);
CREATE INDEX subscriptions_user ON subscriptions(user_id);
CREATE TABLE usage_windows (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,quota INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0));
CREATE TABLE jobs (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,window_id TEXT NOT NULL REFERENCES usage_windows(id),idempotency_key TEXT NOT NULL,title TEXT NOT NULL,mode TEXT NOT NULL,script TEXT NOT NULL,voice TEXT NOT NULL,second_voice TEXT NOT NULL,pause_ms INTEGER NOT NULL,chars INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),audio_key TEXT,duration REAL NOT NULL DEFAULT 0,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_id,idempotency_key));
CREATE INDEX jobs_user ON jobs(user_id,created_at DESC);
CREATE UNIQUE INDEX one_active_job_per_user ON jobs(user_id) WHERE status IN ('queued','running');
-- Reserving quota and refunding failures occur in the same SQLite transaction as the job mutation.
CREATE TRIGGER reserve_job_quota BEFORE INSERT ON jobs BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM usage_windows WHERE id=NEW.window_id AND user_id=NEW.user_id AND used+NEW.chars<=quota) THEN RAISE(ABORT,'QUOTA_EXCEEDED') END;
 UPDATE usage_windows SET used=used+NEW.chars WHERE id=NEW.window_id;
END;
CREATE TRIGGER refund_failed_job AFTER UPDATE OF status ON jobs WHEN NEW.status='failed' AND OLD.status IN ('queued','running') BEGIN
 UPDATE usage_windows SET used=MAX(0,used-NEW.chars) WHERE id=NEW.window_id;
END;
CREATE TABLE billing_events (id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
CREATE TABLE voice_samples (voice_id TEXT PRIMARY KEY,object_key TEXT NOT NULL,mime TEXT NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE contact_messages (id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,message TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY,hits INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE checkout_intents (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,plan TEXT NOT NULL,intent_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE cleanup_tasks (prefix TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
