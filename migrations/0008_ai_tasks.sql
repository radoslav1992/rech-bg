-- Provider-backed media tools ("Медийни инструменти"): dubbing (video translation) now, re-voicing (lipsync) later.
-- The result is a new video in the media library (output_asset_id), reserved when the task is created.
CREATE TABLE IF NOT EXISTS ai_tasks (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('translate','lipsync')),
 source_asset_id TEXT NOT NULL, output_asset_id TEXT NOT NULL,
 params TEXT NOT NULL, window_id TEXT NOT NULL REFERENCES usage_windows(id), credits INTEGER NOT NULL CHECK(credits>=0),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')), phase TEXT NOT NULL DEFAULT 'queued',
 provider_request TEXT, submitted_at INTEGER, error TEXT, token TEXT NOT NULL, idempotency_key TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS ai_tasks_user ON ai_tasks(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ai_tasks_active ON ai_tasks(status,updated_at);
CREATE TRIGGER IF NOT EXISTS ai_task_credit_reserve BEFORE INSERT ON ai_tasks BEGIN SELECT RAISE(ABORT,'QUOTA_EXCEEDED') WHERE NOT EXISTS(SELECT 1 FROM usage_windows WHERE id=NEW.window_id AND user_id=NEW.user_id AND used+NEW.credits<=quota); END;
CREATE TRIGGER IF NOT EXISTS ai_task_credit_charge AFTER INSERT ON ai_tasks BEGIN UPDATE usage_windows SET used=used+NEW.credits WHERE id=NEW.window_id; END;
CREATE TRIGGER IF NOT EXISTS ai_task_credit_refund AFTER UPDATE OF status ON ai_tasks WHEN NEW.status='failed' AND OLD.status IN ('queued','running') BEGIN UPDATE usage_windows SET used=MAX(0,used-NEW.credits) WHERE id=NEW.window_id; END;
-- At most two tools running per account.
CREATE TRIGGER IF NOT EXISTS ai_task_active_limit BEFORE INSERT ON ai_tasks BEGIN SELECT RAISE(ABORT,'AI_TASKS_BUSY') WHERE (SELECT COUNT(*) FROM ai_tasks WHERE user_id=NEW.user_id AND status IN ('queued','running'))>=2; END;
