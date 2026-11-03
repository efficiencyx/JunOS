-- Game bridge. bridge_pub is a crypto_box public key, bridge_sec the
-- matching secret sealed under the data key, so the boot sync can
-- queue events for a user who is not signed in. bridge_inbox holds
-- those events sealed to bridge_pub until the next signed-in request
-- turns them into memory. bridge_seen keeps event ids already queued.
ALTER TABLE users ADD COLUMN bridge_pub TEXT;
ALTER TABLE users ADD COLUMN bridge_sec TEXT;
CREATE TABLE bridge_tokens (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE bridge_sync (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timeline    TEXT NOT NULL,
  sympathy    INTEGER NOT NULL,
  ingame_time INTEGER NOT NULL,
  counters    TEXT NOT NULL,
  outfit      TEXT NOT NULL,
  wardrobe_at INTEGER NOT NULL,
  synced_at   INTEGER NOT NULL
);
CREATE TABLE bridge_seen (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE TABLE bridge_inbox (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sealed  TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX bridge_inbox_user ON bridge_inbox(user_id, id);
INSERT INTO schema_version(v) VALUES (26);
