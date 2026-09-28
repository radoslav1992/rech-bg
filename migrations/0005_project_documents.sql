-- Video studio project documents: scenes, timeline arrangement and references to media (JSON, see shared/project.ts).
-- The revision guards against two tabs or devices overwriting each other's edits.
CREATE TABLE IF NOT EXISTS project_documents (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_documents_user ON project_documents(user_id);
