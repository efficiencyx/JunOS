-- Rolling per-conversation summary. On small-context hosts a long chat overruns
-- num_ctx and Ollama silently drops the oldest turns; instead we fold the oldest
-- messages into a running third-person summary and keep only the recent tail raw.
-- summary_upto_id is the highest message id the summary already subsumes; chat.php
-- drops those leading turns and injects the summary as background context.
ALTER TABLE conversations ADD COLUMN summary TEXT;
ALTER TABLE conversations ADD COLUMN summary_upto_id INTEGER NOT NULL DEFAULT 0;
INSERT INTO schema_version(v) VALUES (3);
