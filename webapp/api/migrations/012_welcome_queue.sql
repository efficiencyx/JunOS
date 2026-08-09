CREATE TABLE IF NOT EXISTS welcome_queue (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  messages     TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);
INSERT INTO schema_version(v) VALUES (12);
