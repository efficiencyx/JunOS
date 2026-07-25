CREATE TABLE IF NOT EXISTS telemetry_consent (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted INTEGER NOT NULL,
  notice_version TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  erasure_requested_at INTEGER
);
INSERT INTO schema_version(v) VALUES (8);
