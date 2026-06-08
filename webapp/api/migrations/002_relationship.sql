-- Hidden per-user relationship state. One row per user (Jun is a single
-- persistent character across all of that user's conversations, like the
-- per-user chat-history RAG). Scores are 0-100; Jun nudges them herself via a
-- hidden [ACTION:mood_shift|...] tag the backend parses out of each reply.
-- Defaults start mild-positive: the persona is already Anon's girlfriend, not a
-- cold first meeting.
CREATE TABLE relationship (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  affection  INTEGER NOT NULL DEFAULT 50,
  trust      INTEGER NOT NULL DEFAULT 50,
  tension    INTEGER NOT NULL DEFAULT 30,
  updated_at INTEGER NOT NULL
);
INSERT INTO schema_version(v) VALUES (2);
