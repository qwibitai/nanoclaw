CREATE TABLE IF NOT EXISTS tool_call_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  group_folder TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_use_id TEXT,
  hook_event TEXT NOT NULL DEFAULT 'PostToolUse',
  tool_input TEXT,
  tool_response TEXT,
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tool_events_session
  ON tool_call_events(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_timestamp
  ON tool_call_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_events_group
  ON tool_call_events(group_folder, timestamp);
