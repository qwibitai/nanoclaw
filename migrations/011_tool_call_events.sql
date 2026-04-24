-- Tool call event observability table.
-- Stores PostToolUse / PostToolUseFailure hook events from agent sessions.
-- 7-day retention, pruned on startup and periodically.

CREATE TABLE IF NOT EXISTS tool_call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'PostToolUse',
  tool_name TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_events_session_created
  ON tool_call_events(session_id, created_at);
