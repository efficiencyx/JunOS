ALTER TABLE memory_consolidation ADD COLUMN last_activity INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_consolidation ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
INSERT INTO schema_version(v) VALUES (5);
