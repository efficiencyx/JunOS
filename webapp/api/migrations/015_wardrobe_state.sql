CREATE TABLE IF NOT EXISTS wardrobe_state (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO schema_version(v) VALUES (15);
