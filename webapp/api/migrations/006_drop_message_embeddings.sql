DROP INDEX IF EXISTS idx_emb_user;
DROP TABLE IF EXISTS message_embeddings;
INSERT INTO schema_version(v) VALUES (6);
