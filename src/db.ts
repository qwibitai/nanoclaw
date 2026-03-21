import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function columnExists(
  database: Database.Database,
  table: string,
  column: string,
): boolean {
  const cols = database.pragma(`table_info(${table})`) as Array<{
    name: string;
  }>;
  return cols.some((c) => c.name === column);
}

function createSchema(database: Database.Database): void {
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
    CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, timestamp);

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
    CREATE TABLE IF NOT EXISTS thread_contexts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid          TEXT NOT NULL,
      thread_id         TEXT,
      session_id        TEXT,
      origin_message_id TEXT,
      source            TEXT NOT NULL,
      task_id           INTEGER,
      created_at        TEXT NOT NULL,
      last_active_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_thread_ctx_chat ON thread_contexts(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_thread_ctx_thread ON thread_contexts(thread_id);
    CREATE INDEX IF NOT EXISTS idx_thread_ctx_origin ON thread_contexts(origin_message_id);
    CREATE TABLE IF NOT EXISTS watched_prs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT DEFAULT 'active',
      last_checked_at TEXT,
      last_comment_id INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(repo, pr_number)
    );
    CREATE INDEX IF NOT EXISTS idx_watched_prs_status ON watched_prs(status);
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

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add skills column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN skills TEXT DEFAULT '["general"]'`,
    );
  } catch {
    /* column already exists */
  }

  // Migrate existing groups from old default ["general"] to new default ["general","coding"]
  try {
    database.exec(
      `UPDATE registered_groups SET skills = '["general","coding"]' WHERE skills = '["general"]'`,
    );
  } catch {
    /* already migrated or table doesn't exist yet */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
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
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Migration: Add processed flag to messages table
  if (!columnExists(database, 'messages', 'processed')) {
    database.exec(
      'ALTER TABLE messages ADD COLUMN processed INTEGER DEFAULT 0',
    );
    database.exec(
      'CREATE INDEX IF NOT EXISTS idx_messages_unprocessed ON messages(processed, chat_jid) WHERE processed = 0',
    );

    // Mark all existing messages as processed — they were already handled
    // by the cursor system before this migration
    database.exec('UPDATE messages SET processed = 1');

    logger.info(
      'Migration: added processed column to messages, marked all existing as processed',
    );
  }

  // Migrate active_threads → thread_contexts
  try {
    const hasActiveThreads = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='active_threads'",
      )
      .get();
    if (hasActiveThreads) {
      const now = new Date().toISOString();
      const rows = database
        .prepare('SELECT chat_jid, thread_id FROM active_threads')
        .all() as Array<{ chat_jid: string; thread_id: string }>;
      for (const row of rows) {
        database
          .prepare(
            `INSERT OR IGNORE INTO thread_contexts (chat_jid, thread_id, source, created_at, last_active_at)
           VALUES (?, ?, 'mention', ?, ?)`,
          )
          .run(row.chat_jid, row.thread_id, now, now);
      }
      database.exec('DROP TABLE active_threads');
    }
  } catch {
    /* migration already done */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR IGNORE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

/**
 * Get recent conversation messages INCLUDING bot messages.
 * Used to provide conversation context when spawning new containers,
 * so the agent has prior context even if session resume fails.
 */
export function getConversationContext(
  chatJid: string,
  limit: number = 20,
): NewMessage[] {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid, limit) as NewMessage[];
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Thread context interfaces ---

export interface ThreadContext {
  id: number;
  chat_jid: string;
  thread_id: string | null;
  session_id: string | null;
  origin_message_id: string | null;
  source: 'mention' | 'reply' | 'scheduled_task';
  task_id: number | null;
  created_at: string;
  last_active_at: string;
}

export interface CreateThreadContextInput {
  chatJid: string;
  threadId: string | null;
  sessionId: string | null;
  originMessageId: string | null;
  source: 'mention' | 'reply' | 'scheduled_task';
  taskId?: number;
}

// --- Thread context CRUD ---

export function createThreadContext(
  input: CreateThreadContextInput,
): ThreadContext {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO thread_contexts (chat_jid, thread_id, session_id, origin_message_id, source, task_id, created_at, last_active_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.chatJid,
      input.threadId ?? null,
      input.sessionId ?? null,
      input.originMessageId ?? null,
      input.source,
      input.taskId ?? null,
      now,
      now,
    );
  return getThreadContextById(result.lastInsertRowid as number)!;
}

export function getThreadContextById(id: number): ThreadContext | undefined {
  return db.prepare('SELECT * FROM thread_contexts WHERE id = ?').get(id) as
    | ThreadContext
    | undefined;
}

export function getThreadContextByThreadId(
  threadId: string,
): ThreadContext | undefined {
  return db
    .prepare(
      'SELECT * FROM thread_contexts WHERE thread_id = ? ORDER BY last_active_at DESC, id DESC LIMIT 1',
    )
    .get(threadId) as ThreadContext | undefined;
}

export function getThreadContextByOriginMessage(
  originMessageId: string,
): ThreadContext | undefined {
  return db
    .prepare(
      'SELECT * FROM thread_contexts WHERE origin_message_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(originMessageId) as ThreadContext | undefined;
}

export function updateThreadContext(
  id: number,
  updates: { threadId?: string; sessionId?: string | null; taskId?: number },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.threadId !== undefined) {
    fields.push('thread_id = ?');
    values.push(updates.threadId);
  }
  if (updates.sessionId !== undefined) {
    fields.push('session_id = ?');
    values.push(updates.sessionId);
  }
  if (updates.taskId !== undefined) {
    fields.push('task_id = ?');
    values.push(updates.taskId);
  }
  if (fields.length === 0) return;
  fields.push('last_active_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(
    `UPDATE thread_contexts SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function touchThreadContext(id: number): void {
  db.prepare('UPDATE thread_contexts SET last_active_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    id,
  );
}

export function getActiveThreadContexts(
  chatJid: string,
  expiryHours: number,
): ThreadContext[] {
  const cutoff = new Date(
    Date.now() - expiryHours * 60 * 60 * 1000,
  ).toISOString();
  return db
    .prepare(
      'SELECT * FROM thread_contexts WHERE chat_jid = ? AND last_active_at > ? ORDER BY last_active_at DESC, id DESC',
    )
    .all(chatJid, cutoff) as ThreadContext[];
}

// --- Watched PR accessors ---

export interface WatchedPr {
  id: number;
  repo: string;
  pr_number: number;
  group_folder: string;
  chat_jid: string;
  source: string;
  status: string;
  last_checked_at: string | null;
  last_comment_id: number | null;
  created_at: string;
}

export function addWatchedPr(pr: {
  repo: string;
  pr_number: number;
  group_folder: string;
  chat_jid: string;
  source: string;
}): void {
  db.prepare(
    `INSERT INTO watched_prs (repo, pr_number, group_folder, chat_jid, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo, pr_number) DO UPDATE SET
       group_folder = excluded.group_folder,
       chat_jid = excluded.chat_jid,
       source = excluded.source,
       status = 'active'`,
  ).run(
    pr.repo,
    pr.pr_number,
    pr.group_folder,
    pr.chat_jid,
    pr.source,
    new Date().toISOString(),
  );
}

export function getWatchedPr(
  repo: string,
  prNumber: number,
): WatchedPr | undefined {
  return db
    .prepare('SELECT * FROM watched_prs WHERE repo = ? AND pr_number = ?')
    .get(repo, prNumber) as WatchedPr | undefined;
}

export function getActiveWatchedPrs(): WatchedPr[] {
  return db
    .prepare(
      "SELECT * FROM watched_prs WHERE status = 'active' ORDER BY created_at",
    )
    .all() as WatchedPr[];
}

export function updateWatchedPr(
  repo: string,
  prNumber: number,
  updates: Partial<
    Pick<WatchedPr, 'status' | 'last_checked_at' | 'last_comment_id'>
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.last_checked_at !== undefined) {
    fields.push('last_checked_at = ?');
    values.push(updates.last_checked_at);
  }
  if (updates.last_comment_id !== undefined) {
    fields.push('last_comment_id = ?');
    values.push(updates.last_comment_id);
  }
  if (fields.length === 0) return;
  values.push(repo, prNumber);
  db.prepare(
    `UPDATE watched_prs SET ${fields.join(', ')} WHERE repo = ? AND pr_number = ?`,
  ).run(...values);
}

export function unwatchPr(repo: string, prNumber: number): void {
  db.prepare(
    "UPDATE watched_prs SET status = 'unwatched' WHERE repo = ? AND pr_number = ?",
  ).run(repo, prNumber);
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        skills: string | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  let containerConfig;
  try {
    containerConfig = row.container_config
      ? JSON.parse(row.container_config)
      : undefined;
  } catch {
    logger.warn({ jid: row.jid }, 'Invalid container_config JSON, ignoring');
  }
  let skills: string[] = ['general', 'coding'];
  try {
    skills = row.skills ? JSON.parse(row.skills) : ['general', 'coding'];
  } catch {
    logger.warn({ jid: row.jid }, 'Invalid skills JSON, using default');
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    skills,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, skills)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.skills ? JSON.stringify(group.skills) : '["general","coding"]',
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    skills: string | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    let containerConfig;
    try {
      containerConfig = row.container_config
        ? JSON.parse(row.container_config)
        : undefined;
    } catch {
      logger.warn({ jid: row.jid }, 'Invalid container_config JSON, ignoring');
    }
    let skills: string[] = ['general', 'coding'];
    try {
      skills = row.skills ? JSON.parse(row.skills) : ['general', 'coding'];
    } catch {
      logger.warn({ jid: row.jid }, 'Invalid skills JSON, using default');
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      skills,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
