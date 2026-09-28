-- Brand kit per account (logo, colours, caption look, intro/outro; JSON, see shared/brand.ts).
CREATE TABLE IF NOT EXISTS brand_kits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kit TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Saved project structures to start new video studio projects from (no recordings or videos).
CREATE TABLE IF NOT EXISTS studio_templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS studio_templates_user ON studio_templates(user_id,created_at DESC);
