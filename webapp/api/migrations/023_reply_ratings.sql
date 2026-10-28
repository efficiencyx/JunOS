-- admin thumbs on her replies, read back only by ratings.php?action=export
CREATE TABLE reply_ratings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER,
  message_id      INTEGER,
  rating          INTEGER NOT NULL,
  model           TEXT,
  context         TEXT NOT NULL,
  reply           TEXT NOT NULL,
  at              INTEGER NOT NULL
);
CREATE UNIQUE INDEX reply_ratings_message ON reply_ratings(user_id, message_id);
INSERT INTO schema_version(v) VALUES (23);
