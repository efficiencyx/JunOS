-- carry_* is the leftover of a scaled gauge move, in hundredths of a point.
-- user_bans.blocked is the last hardcore walkout, the app stays locked.
CREATE TABLE difficulty (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  level           TEXT NOT NULL,
  carry_affection INTEGER NOT NULL DEFAULT 0,
  carry_trust     INTEGER NOT NULL DEFAULT 0,
  carry_tension   INTEGER NOT NULL DEFAULT 0,
  picked_at       INTEGER NOT NULL
);
ALTER TABLE user_bans ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_version(v) VALUES (28);
