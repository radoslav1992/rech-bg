-- "Моите аватари": a photo turned once into a reusable HeyGen avatar, paid once in credits and then used in videos.
CREATE TABLE IF NOT EXISTS user_avatars (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, image_key TEXT NOT NULL, mime TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','ready','failed')),
 look_id TEXT, group_id TEXT, engines TEXT, error TEXT,
 window_id TEXT NOT NULL REFERENCES usage_windows(id), credits INTEGER NOT NULL CHECK(credits>=0),
 idempotency_key TEXT NOT NULL, token TEXT NOT NULL, consent_at INTEGER NOT NULL, consent_text TEXT NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS user_avatars_user ON user_avatars(user_id,created_at DESC);
CREATE TRIGGER IF NOT EXISTS user_avatar_credit_reserve BEFORE INSERT ON user_avatars BEGIN SELECT RAISE(ABORT,'QUOTA_EXCEEDED') WHERE NOT EXISTS(SELECT 1 FROM usage_windows WHERE id=NEW.window_id AND user_id=NEW.user_id AND used+NEW.credits<=quota); END;
CREATE TRIGGER IF NOT EXISTS user_avatar_credit_charge AFTER INSERT ON user_avatars BEGIN UPDATE usage_windows SET used=used+NEW.credits WHERE id=NEW.window_id; END;
CREATE TRIGGER IF NOT EXISTS user_avatar_credit_refund AFTER UPDATE OF status ON user_avatars WHEN NEW.status='failed' AND OLD.status='processing' BEGIN UPDATE usage_windows SET used=MAX(0,used-NEW.credits) WHERE id=NEW.window_id; END;
-- Deleting an account removes the stored photos and the avatars in HeyGen.
CREATE TRIGGER IF NOT EXISTS user_avatar_account_cleanup BEFORE DELETE ON users BEGIN
 INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) VALUES('avatars/'||OLD.id||'/',unixepoch());
 INSERT OR IGNORE INTO cleanup_tasks(prefix,created_at) SELECT 'heygen-avatar/'||id||'/'||group_id,unixepoch() FROM user_avatars WHERE user_id=OLD.id AND group_id IS NOT NULL;
END;
