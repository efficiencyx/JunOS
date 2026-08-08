CREATE TABLE IF NOT EXISTS wardrobe_presets (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
INSERT INTO schema_version(v) VALUES (11);
