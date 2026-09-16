CREATE TABLE IF NOT EXISTS media_limits (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, max_bytes INTEGER NOT NULL, retention_days INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media_assets (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 object_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('upload','portrait','product','variant','export','audio','video')),
 mime TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0), status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','checking','ready','deleting')),
 duration REAL NOT NULL DEFAULT 0, upload_id TEXT, captions TEXT, saved INTEGER NOT NULL DEFAULT 0,
 job_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_assets_user ON media_assets(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS media_assets_expiry ON media_assets(expires_at);
CREATE TRIGGER IF NOT EXISTS media_storage_reserve BEFORE INSERT ON media_assets BEGIN SELECT RAISE(ABORT,'STORAGE_FULL') WHERE NEW.bytes + COALESCE((SELECT SUM(bytes) FROM media_assets WHERE user_id=NEW.user_id),0) > COALESCE((SELECT max_bytes FROM media_limits WHERE user_id=NEW.user_id),0); END;
CREATE TABLE IF NOT EXISTS media_parts (asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE, part INTEGER NOT NULL, etag TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(asset_id,part));
CREATE TABLE IF NOT EXISTS media_tasks (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('inspect','transcribe','export','product')),
 source_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, window_id TEXT NOT NULL REFERENCES usage_windows(id), credits INTEGER NOT NULL CHECK(credits>=0),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')), phase TEXT NOT NULL DEFAULT 'queued',
 payload TEXT NOT NULL, result TEXT, provider TEXT, submitted_at INTEGER, error TEXT, token TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS media_tasks_user ON media_tasks(user_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS media_one_active ON media_tasks(user_id) WHERE status IN ('queued','running');
CREATE TRIGGER IF NOT EXISTS media_credit_reserve BEFORE INSERT ON media_tasks BEGIN SELECT RAISE(ABORT,'QUOTA_EXCEEDED') WHERE NOT EXISTS(SELECT 1 FROM usage_windows WHERE id=NEW.window_id AND user_id=NEW.user_id AND used+NEW.credits<=quota); END;
CREATE TRIGGER IF NOT EXISTS media_credit_charge AFTER INSERT ON media_tasks BEGIN UPDATE usage_windows SET used=used+NEW.credits WHERE id=NEW.window_id; END;
CREATE TRIGGER IF NOT EXISTS media_credit_refund AFTER UPDATE OF status ON media_tasks WHEN NEW.status='failed' AND OLD.status IN ('queued','running') BEGIN UPDATE usage_windows SET used=MAX(0,used-NEW.credits) WHERE id=NEW.window_id; END;
CREATE TRIGGER IF NOT EXISTS media_user_cleanup BEFORE DELETE ON users BEGIN INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES('media/'||OLD.id||'/',unixepoch()); END;
CREATE TABLE IF NOT EXISTS media_job_history (job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE);
CREATE TRIGGER IF NOT EXISTS media_file_count BEFORE INSERT ON media_assets BEGIN SELECT RAISE(ABORT,'STORAGE_FULL') WHERE (SELECT COUNT(*) FROM media_assets WHERE user_id=NEW.user_id)>=300; END;
CREATE TRIGGER IF NOT EXISTS media_record_job AFTER INSERT ON media_assets WHEN NEW.job_id IS NOT NULL BEGIN INSERT OR IGNORE INTO media_job_history(job_id) VALUES(NEW.job_id); END;
CREATE TABLE IF NOT EXISTS media_task_assets (task_id TEXT NOT NULL REFERENCES media_tasks(id) ON DELETE CASCADE,asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,PRIMARY KEY(task_id,asset_id));
CREATE TRIGGER IF NOT EXISTS media_input_ready BEFORE INSERT ON media_task_assets BEGIN SELECT RAISE(ABORT,'MEDIA_INPUT_UNAVAILABLE') WHERE NOT EXISTS(SELECT 1 FROM media_assets a JOIN media_tasks t ON t.id=NEW.task_id WHERE a.id=NEW.asset_id AND a.user_id=t.user_id AND a.expires_at>unixepoch() AND (a.status='ready' OR (t.kind='inspect' AND a.status IN ('uploading','checking')))); END;
CREATE TRIGGER IF NOT EXISTS media_unlock AFTER UPDATE OF status ON media_tasks WHEN NEW.status IN ('completed','failed') BEGIN DELETE FROM media_task_assets WHERE task_id=NEW.id; END;
CREATE TRIGGER IF NOT EXISTS media_block_account_delete BEFORE DELETE ON users WHEN EXISTS(SELECT 1 FROM media_tasks WHERE user_id=OLD.id AND status IN ('queued','running')) BEGIN SELECT RAISE(ABORT,'MEDIA_ACTIVE'); END;
