-- Achievement counters, one row per user and stat. Peaks and low
-- points are stored the same way; lib/achievements.php decides
-- whether a stat is added to, maxed or minned. "seen" holds the
-- highest tier per achievement that the client already showed a
-- toast for.
CREATE TABLE achievement_stats (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stat       TEXT NOT NULL,
  value      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, stat)
);
CREATE TABLE achievement_seen (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ach     TEXT NOT NULL,
  tier    INTEGER NOT NULL,
  PRIMARY KEY (user_id, ach)
);
INSERT INTO schema_version(v) VALUES (19);
