ALTER TABLE memory_consolidation ADD COLUMN last_status TEXT NOT NULL DEFAULT '';
ALTER TABLE memory_consolidation ADD COLUMN last_note_count INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_version(v) VALUES (7);
