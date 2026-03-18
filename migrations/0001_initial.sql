-- ThagomizerClaw — Cloudflare D1 Schema
-- Mirrors the SQLite schema from src/db.ts, adapted for D1 (async, globally replicated)
-- Apply with: wrangler d1 migrations apply thagomizer-claw-db

-- ─── Chat Metadata ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT,
  channel TEXT,
  is_group INTEGER DEFAULT 0
);

-- ─── Messages ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER,
  is_bot_message INTEGER DEFAULT 0,
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);

CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_chat_jid ON messages(chat_jid, timestamp);

-- ─── Registered Groups ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS registered_groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  trigger_pattern TEXT NOT NULL,
  added_at TEXT NOT NULL,
  agent_config TEXT,           -- JSON: AgentConfig (model, timeout, useWorkersAI)
  requires_trigger INTEGER DEFAULT 1,
  is_main INTEGER DEFAULT 0
);

-- ─── Sessions ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sessions (
  group_folder TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ─── Scheduled Tasks ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL,     -- 'cron' | 'interval' | 'once'
  schedule_value TEXT NOT NULL,    -- cron expression | milliseconds | ISO timestamp
  context_mode TEXT DEFAULT 'isolated',
  next_run TEXT,
  last_run TEXT,
  last_result TEXT,
  status TEXT DEFAULT 'active',    -- 'active' | 'paused' | 'completed'
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(next_run);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks(status);

-- ─── Task Run Logs ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,           -- 'success' | 'error'
  result TEXT,
  error TEXT,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
);

CREATE INDEX IF NOT EXISTS idx_task_run_logs_task_id ON task_run_logs(task_id, run_at);
