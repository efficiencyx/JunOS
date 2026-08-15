-- sessions.token now stores sha256 of the cookie. Rows written before this
-- migration hold the cookie itself and cannot be converted (SQLite has no
-- sha256, and the two values are indistinguishable 64-char hex strings), so
-- they are removed. Every signed-in user has to sign in again once.
DELETE FROM sessions;
INSERT INTO schema_version(v) VALUES (14);
