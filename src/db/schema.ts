import type Database from 'better-sqlite3';

import { ASSISTANT_NAME } from '../config.js';

/**
 * Create the full schema, including ALTER TABLE migrations for legacy
 * databases. Safe to call repeatedly — each migration is idempotent.
 */
export function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
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
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Each ALTER runs inside its own try/catch because SQLite raises on
  // duplicate columns rather than supporting IF NOT EXISTS for ADD COLUMN.
  const alter = (sql: string, after?: () => void) => {
    try {
      database.exec(sql);
      after?.();
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      /* column already exists */
    }
  };

  alter(
    `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
  );
  alter(`ALTER TABLE scheduled_tasks ADD COLUMN name TEXT`, () => {
    // Backfill: copy custom IDs as names for human-readable task IDs
    database.exec(
      `UPDATE scheduled_tasks SET name = id WHERE id NOT LIKE 'task-%'`,
    );
  });
  alter(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  alter(
    `ALTER TABLE scheduled_tasks ADD COLUMN silent INTEGER DEFAULT 0`,
  );
  alter(`ALTER TABLE scheduled_tasks ADD COLUMN model TEXT`);
  alter(`ALTER TABLE scheduled_tasks ADD COLUMN effort TEXT`);
  alter(
    `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    () => {
      // Backfill: mark existing bot messages using the content prefix pattern
      database
        .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
        .run(`${ASSISTANT_NAME}:%`);
    },
  );
  alter(
    `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    () => {
      database.exec(
        `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
      );
    },
  );
  alter(`ALTER TABLE registered_groups ADD COLUMN model TEXT`);
  alter(`ALTER TABLE registered_groups ADD COLUMN effort TEXT`);
  alter(`ALTER TABLE registered_groups ADD COLUMN thinking_budget TEXT`);
  alter(`ALTER TABLE scheduled_tasks ADD COLUMN thinking_budget TEXT`);

  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    /* columns already exist */
  }

  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    /* columns already exist */
  }

  // Outbox: persists unsent agent responses for retry after restart
  database.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempts INTEGER DEFAULT 0
    );
  `);
}
