-- From this migration on, sessions.token stores sha256 of the
-- cookie. Rows written before it hold the cookie itself and cannot
-- be converted, because SQLite has no sha256 and the two values
-- are indistinguishable 64-char hex strings. They are removed, so
-- every signed-in user has to sign in again once.
DELETE FROM sessions;
INSERT INTO schema_version(v) VALUES (14);
