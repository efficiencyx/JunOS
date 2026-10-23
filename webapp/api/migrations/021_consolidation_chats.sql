-- Per-conversation watermarks for the guided consolidation pass.
-- upto_id is the last message the notes step finished, journal_upto
-- the last one the journal step wrote about. Both fall back to
-- memory_consolidation.upto_id when lower, so history consolidated
-- before this migration is not read again.
CREATE TABLE consolidation_chats (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  upto_id         INTEGER NOT NULL DEFAULT 0,
  journal_upto    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, conversation_id)
);
-- force_at: a developer asked for a pass now. interrupt_at: the user
-- stopped the running pass. game_day / game_trust: trust already
-- granted by the filing game on that local day, for the daily cap.
ALTER TABLE memory_consolidation ADD COLUMN force_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_consolidation ADD COLUMN interrupt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_consolidation ADD COLUMN game_day INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_consolidation ADD COLUMN game_trust INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_version(v) VALUES (21);
