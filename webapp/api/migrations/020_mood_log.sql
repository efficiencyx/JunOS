-- One row per mood_shift Jun applied, newest few are read back to
-- spot a conversation going sour. mood_log_add() keeps the
-- newest 10 per user.
CREATE TABLE mood_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  affection INTEGER NOT NULL,
  trust     INTEGER NOT NULL,
  tension   INTEGER NOT NULL,
  at        INTEGER NOT NULL
);
CREATE INDEX mood_log_user ON mood_log(user_id, id);
INSERT INTO schema_version(v) VALUES (20);
