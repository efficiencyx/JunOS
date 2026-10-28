-- gauges after every change, event is NULL, 'outing:<where>' or 'walkout'
CREATE TABLE relationship_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  affection INTEGER NOT NULL,
  trust     INTEGER NOT NULL,
  tension   INTEGER NOT NULL,
  event     TEXT,
  at        INTEGER NOT NULL
);
CREATE INDEX relationship_history_user ON relationship_history(user_id, id);
INSERT INTO schema_version(v) VALUES (24);
