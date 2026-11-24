-- Developer controls for the guided memory pass. pause_at: the running
-- pass waits before its next call while this is set, 0 = not paused.
-- skip_kind / skip_at: the last skip asked for (call, item, chat or
-- step); a pass applies each one once. force_mode: what a queued run
-- is, '' a normal forced pass, 'resume' to continue a stopped pass with
-- its feed, 'dry' to run without writing anything.
ALTER TABLE memory_consolidation ADD COLUMN pause_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_consolidation ADD COLUMN skip_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_consolidation ADD COLUMN skip_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_consolidation ADD COLUMN force_mode TEXT NOT NULL DEFAULT '';
INSERT INTO schema_version(v) VALUES (29);
