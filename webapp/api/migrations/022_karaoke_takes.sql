-- One row per scored karaoke take. song is an HMAC of the audio
-- file's sha256 under the user's data key, so takes of the same file
-- group together without the hash identifying the file. lines is
-- sealed JSON: per sung line its index, matched and total words and
-- mean timing offset in ms.
CREATE TABLE karaoke_takes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  song      TEXT NOT NULL,
  mode      TEXT NOT NULL,
  score     INTEGER NOT NULL,
  matched   INTEGER NOT NULL,
  total     INTEGER NOT NULL,
  offset_ms INTEGER,
  lines     TEXT,
  at        INTEGER NOT NULL
);
CREATE INDEX karaoke_takes_user_song ON karaoke_takes(user_id, song, id);
INSERT INTO schema_version(v) VALUES (22);
