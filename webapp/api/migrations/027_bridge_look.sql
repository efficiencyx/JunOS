-- look: the styles, logos and colours of the last sync.
-- look_pending: the same, waiting for the browser to take it.
ALTER TABLE bridge_sync ADD COLUMN look TEXT NOT NULL DEFAULT '';
ALTER TABLE bridge_sync ADD COLUMN look_pending TEXT NOT NULL DEFAULT '';
INSERT INTO schema_version(v) VALUES (27);
