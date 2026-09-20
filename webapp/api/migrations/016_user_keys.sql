-- Per-user data keys. kdf_salt seeds Argon2id over the password;
-- wrapped_dek and recovery_wrapped_dek hold the same random key
-- sealed under that hash and under the recovery code. All three
-- stay NULL until the account's first sign-in after this
-- migration, which mints them and encrypts its existing rows and
-- memory files in place. Sessions are removed because the key now
-- travels in a second cookie that older sessions do not carry.
ALTER TABLE users ADD COLUMN kdf_salt TEXT;
ALTER TABLE users ADD COLUMN wrapped_dek TEXT;
ALTER TABLE users ADD COLUMN recovery_wrapped_dek TEXT;
DELETE FROM sessions;
INSERT INTO schema_version(v) VALUES (16);
