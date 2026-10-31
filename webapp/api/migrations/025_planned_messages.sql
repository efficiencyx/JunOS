-- Texts Jun schedules with the plan_message tool. text is sealed
-- with the user's data key. delivered_at stays NULL until the
-- welcome scene shows the text.
CREATE TABLE planned_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  due_at       INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX planned_messages_waiting ON planned_messages(user_id, delivered_at, due_at);
INSERT INTO schema_version(v) VALUES (25);
