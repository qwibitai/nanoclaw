-- Tool call event observability table.
-- Stores PostToolUse / PostToolUseFailure hook events from agent sessions.
-- 7-day retention, pruned on startup and periodically.

CREATE TABLE IF NOT EXISTS tool_call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_use_id TEXT,
  hook_event TEXT NOT NULL DEFAULT 'PostToolUse',
  tool_input TEXT,
  tool_response TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_events_session_created
  ON tool_call_events(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_tool_events_group_created
  ON tool_call_events(group_folder, created_at)
