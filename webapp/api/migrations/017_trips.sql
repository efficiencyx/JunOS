CREATE TABLE IF NOT EXISTS trips (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  destination     TEXT NOT NULL,
  since           INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL DEFAULT 0
);
INSERT INTO schema_version(v) VALUES (17);
