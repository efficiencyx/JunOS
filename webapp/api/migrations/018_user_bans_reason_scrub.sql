UPDATE user_bans SET reason = NULL WHERE reason IS NOT NULL AND reason NOT LIKE 'v1:%';
INSERT INTO schema_version(v) VALUES (18);
