CREATE TABLE karaoke_jobs (
  token_hash           TEXT PRIMARY KEY,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sidecar_token        TEXT NOT NULL,
  expires_at           INTEGER NOT NULL,
  instrumental_fetched INTEGER NOT NULL DEFAULT 0,
  guide_fetched        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_karaoke_jobs_expiry ON karaoke_jobs(expires_at);
INSERT INTO schema_version(v) VALUES (13);
