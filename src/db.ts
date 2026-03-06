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
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS worker_runs (
      run_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      lane_id TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      result_summary TEXT,
      files_changed TEXT,
      dispatch_repo TEXT,
      dispatch_branch TEXT,
      request_id TEXT,
      context_intent TEXT,
      dispatch_payload TEXT,
      parent_run_id TEXT,
      dispatch_session_id TEXT,
      selected_session_id TEXT,
      effective_session_id TEXT,
      session_selection_source TEXT,
      session_resume_status TEXT,
      session_resume_error TEXT,
      phase TEXT DEFAULT 'queued',
      last_heartbeat_at TEXT,
      spawn_acknowledged_at TEXT,
      active_container_name TEXT,
      no_container_since TEXT,
      expects_followup_container INTEGER DEFAULT 0,
      supervisor_owner TEXT,
      lease_expires_at TEXT,
      recovered_from_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_worker_runs_folder ON worker_runs(group_folder, started_at);

    CREATE TABLE IF NOT EXISTS andy_requests (
      request_id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      source_group_folder TEXT NOT NULL,
      source_lane_id TEXT,
      user_message_id TEXT NOT NULL UNIQUE,
      user_prompt TEXT NOT NULL,
      intent TEXT NOT NULL,
      state TEXT NOT NULL,
      worker_run_id TEXT,
      worker_group_folder TEXT,
      coordinator_session_id TEXT,
      last_status_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_andy_requests_chat_state
      ON andy_requests(chat_jid, state, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_andy_requests_worker_run
      ON andy_requests(worker_run_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_andy_requests_created
      ON andy_requests(created_at DESC);

    CREATE TABLE IF NOT EXISTS dispatch_attempts (
      attempt_id TEXT PRIMARY KEY,
      request_id TEXT,
      source_lane_id TEXT NOT NULL,
      target_lane_id TEXT NOT NULL,
      run_id TEXT,
      status TEXT NOT NULL,
      reason_code TEXT,
      reason_text TEXT,
      session_strategy TEXT,
      dispatch_payload TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_request
      ON dispatch_attempts(request_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_run
      ON dispatch_attempts(run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dispatch_attempts_status
      ON dispatch_attempts(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS processed_messages (
      chat_jid TEXT NOT NULL,
      message_id TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      run_id TEXT,
      PRIMARY KEY (chat_jid, message_id)
    );
    CREATE TABLE IF NOT EXISTS worker_steering_events (
      steer_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      from_group TEXT NOT NULL,
      message TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      acked_at TEXT,
      status TEXT DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS idx_steering_run_id ON worker_steering_events(run_id);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add worker_runs extended columns (migration for existing DBs)
  const workerRunsMigrations = [
    `ALTER TABLE worker_runs ADD COLUMN retry_count INTEGER DEFAULT 0`,
    `ALTER TABLE worker_runs ADD COLUMN error_details TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN branch_name TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN pr_url TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN commit_sha TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN files_changed TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN test_summary TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN risk_summary TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN dispatch_repo TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN dispatch_branch TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN request_id TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN context_intent TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN dispatch_payload TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN parent_run_id TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN dispatch_session_id TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN selected_session_id TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN effective_session_id TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN session_selection_source TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN session_resume_status TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN session_resume_error TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN phase TEXT DEFAULT 'queued'`,
    `ALTER TABLE worker_runs ADD COLUMN last_heartbeat_at TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN spawn_acknowledged_at TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN active_container_name TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN no_container_since TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN expects_followup_container INTEGER DEFAULT 0`,
    `ALTER TABLE worker_runs ADD COLUMN supervisor_owner TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN lease_expires_at TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN recovered_from_reason TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN last_progress_summary TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN last_progress_at TEXT`,
    `ALTER TABLE worker_runs ADD COLUMN steer_count INTEGER DEFAULT 0`,
    `ALTER TABLE worker_runs ADD COLUMN lane_id TEXT`,
  ];
  for (const sql of workerRunsMigrations) {
    try {
      database.exec(sql);
    } catch {
      /* column already exists */
    }
  }

  // Backfill lifecycle phases for pre-existing rows.
  database.exec(`
    UPDATE worker_runs
       SET phase = CASE
         WHEN status = 'queued' THEN 'queued'
         WHEN status = 'running' THEN 'active'
         ELSE 'terminal'
       END
     WHERE phase IS NULL
        OR TRIM(phase) = '';
  `);
  database.exec(`
    UPDATE worker_runs
       SET lane_id = group_folder
     WHERE lane_id IS NULL
       AND group_folder LIKE 'jarvis-worker-%';
  `);

  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder IN ('main', 'whatsapp_main')`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE andy_requests ADD COLUMN source_lane_id TEXT`);
  } catch {
    /* column already exists */
  }
  database.exec(`
    UPDATE andy_requests
       SET source_lane_id = CASE
         WHEN source_group_folder IN ('whatsapp_main', 'main') THEN 'main'
         ELSE source_group_folder
       END
     WHERE source_lane_id IS NULL
        OR TRIM(source_lane_id) = '';
  `);

  // Create indexes that depend on migrated worker_runs columns after migrations
  // so startup succeeds on existing databases created before these fields existed.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_worker_runs_context_lookup
      ON worker_runs(group_folder, dispatch_repo, dispatch_branch, started_at);
    CREATE INDEX IF NOT EXISTS idx_worker_runs_effective_session
      ON worker_runs(effective_session_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_worker_runs_request_id
      ON worker_runs(request_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_worker_runs_lane_id
      ON worker_runs(lane_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_andy_requests_source_lane
      ON andy_requests(source_lane_id, updated_at DESC);
  `);

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
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Enable foreign keys constraint enforcement for data integrity
  db.exec('PRAGMA foreign_keys = ON');

  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  // Enable foreign keys constraint enforcement for data integrity
  db.exec('PRAGMA foreign_keys = ON');
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
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
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
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
  lastCursor: string,
  botPrefix: string,
): { messages: NewMessage[]; newCursor: string; newTimestamp: string } {
  if (jids.length === 0) {
    return { messages: [], newCursor: lastCursor, newTimestamp: lastCursor };
  }

  // Parse composite cursor: "timestamp|messageId" or just "timestamp" for backward compat
  let lastTimestamp = lastCursor;
  let lastMessageId = '';
  if (lastCursor.includes('|')) {
    [lastTimestamp, lastMessageId] = lastCursor.split('|');
  }

  const placeholders = jids.map(() => '?').join(',');

  // Use composite cursor for deterministic ordering:
  // (timestamp > last) OR (timestamp = last AND id > lastId)
  // This prevents message loss when multiple messages share the same timestamp.
  const sql = lastMessageId
    ? `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE ((timestamp > ?) OR (timestamp = ? AND id > ?))
      AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp, id
  `
    : `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp, id
  `;

  const params = lastMessageId
    ? [lastTimestamp, lastTimestamp, lastMessageId, ...jids, `${botPrefix}:%`]
    : [lastTimestamp, ...jids, `${botPrefix}:%`];

  const rows = db.prepare(sql).all(...params) as NewMessage[];

  // Build composite cursor: timestamp|messageId
  let newCursor = lastCursor;
  let newTimestamp = lastTimestamp;
  if (rows.length > 0) {
    const lastRow = rows[rows.length - 1];
    newCursor = `${lastRow.timestamp}|${lastRow.id}`;
    newTimestamp = lastRow.timestamp;
  }

  return { messages: rows, newCursor, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
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
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
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
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- Worker run deduplication ---

export type WorkerRunStatus =
  | 'queued'
  | 'running'
  | 'review_requested'
  | 'failed_contract'
  | 'done'
  | 'failed';

export type WorkerRunPhase =
  | 'queued'
  | 'spawning'
  | 'active'
  | 'completion_validating'
  | 'completion_repair_pending'
  | 'completion_repair_active'
  | 'finalizing'
  | 'terminal';

export interface WorkerRunRecord {
  run_id: string;
  group_folder: string;
  lane_id: string | null;
  status: WorkerRunStatus;
  phase: WorkerRunPhase | string | null;
  started_at: string;
  completed_at: string | null;
  retry_count: number;
  result_summary: string | null;
  error_details: string | null;
  branch_name: string | null;
  pr_url: string | null;
  commit_sha: string | null;
  files_changed: string | null;
  test_summary: string | null;
  risk_summary: string | null;
  dispatch_repo: string | null;
  dispatch_branch: string | null;
  request_id: string | null;
  context_intent: string | null;
  dispatch_payload: string | null;
  parent_run_id: string | null;
  dispatch_session_id: string | null;
  selected_session_id: string | null;
  effective_session_id: string | null;
  session_selection_source: string | null;
  session_resume_status: string | null;
  session_resume_error: string | null;
  last_heartbeat_at: string | null;
  spawn_acknowledged_at: string | null;
  active_container_name: string | null;
  no_container_since: string | null;
  expects_followup_container: number | null;
  supervisor_owner: string | null;
  lease_expires_at: string | null;
  recovered_from_reason: string | null;
}

export interface WorkerRunDispatchMetadata {
  lane_id?: string;
  dispatch_repo?: string;
  dispatch_branch?: string;
  request_id?: string;
  context_intent?: 'continue' | 'fresh';
  dispatch_payload?: string;
  parent_run_id?: string;
  dispatch_session_id?: string;
  selected_session_id?: string;
  session_selection_source?: 'explicit' | 'auto_repo_branch' | 'new';
}

export type AndyRequestIntent = 'status_query' | 'work_intake' | 'other';

export type AndyRequestState =
  | 'received'
  | 'queued_for_coordinator'
  | 'coordinator_active'
  | 'worker_queued'
  | 'worker_running'
  | 'worker_review_requested'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AndyRequestRecord {
  request_id: string;
  chat_jid: string;
  source_group_folder: string;
  source_lane_id: string | null;
  user_message_id: string;
  user_prompt: string;
  intent: AndyRequestIntent | string;
  state: AndyRequestState | string;
  worker_run_id: string | null;
  worker_group_folder: string | null;
  coordinator_session_id: string | null;
  last_status_text: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export type DispatchAttemptStatus = 'blocked' | 'queued' | 'failed' | 'superseded';

export interface DispatchAttemptRecord {
  attempt_id: string;
  request_id: string | null;
  source_lane_id: string;
  target_lane_id: string;
  run_id: string | null;
  status: DispatchAttemptStatus | string;
  reason_code: string | null;
  reason_text: string | null;
  session_strategy: string | null;
  dispatch_payload: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkerRunSessionMetadata {
  effective_session_id?: string | null;
  session_resume_status?: 'resumed' | 'fallback_new' | 'new' | null;
  session_resume_error?: string | null;
}

export interface WorkerRunLifecyclePatch {
  phase?: WorkerRunPhase | null;
  last_heartbeat_at?: string | null;
  spawn_acknowledged_at?: string | null;
  active_container_name?: string | null;
  no_container_since?: string | null;
  expects_followup_container?: boolean | null;
  supervisor_owner?: string | null;
  lease_expires_at?: string | null;
  recovered_from_reason?: string | null;
}

const TERMINAL_WORKER_RUN_STATUSES: Set<WorkerRunStatus> = new Set([
  'review_requested',
  'done',
  'failed',
  'failed_contract',
]);

function isTerminalWorkerRunStatus(status: WorkerRunStatus): boolean {
  return TERMINAL_WORKER_RUN_STATUSES.has(status);
}

/** Status set where a duplicate dispatch/execution should be blocked. */
const NON_RETRYABLE_WORKER_STATUSES: Set<string> = new Set([
  'queued', 'running', 'review_requested', 'done',
]);

export function isNonRetryableWorkerStatus(status: string): boolean {
  return NON_RETRYABLE_WORKER_STATUSES.has(status);
}

function canTransitionWorkerRunStatus(
  current: WorkerRunStatus,
  next: WorkerRunStatus,
): boolean {
  if (current === next) return true;
  switch (current) {
    case 'queued':
      return next === 'running'
        || next === 'review_requested'
        || next === 'done'
        || next === 'failed'
        || next === 'failed_contract';
    case 'running':
      return next === 'review_requested'
        || next === 'done'
        || next === 'failed'
        || next === 'failed_contract';
    case 'review_requested':
      return next === 'done';
    case 'done':
    case 'failed':
    case 'failed_contract':
      return false;
    default:
      return false;
  }
}

/**
 * Insert a worker run record.
 * - 'new': run_id not seen before, inserted with status 'queued'
 * - 'retry': run_id exists with status 'failed' or 'failed_contract'
 * - 'duplicate': run_id exists with any other status
 */
export function insertWorkerRun(
  runId: string,
  groupFolder: string,
  metadata?: WorkerRunDispatchMetadata,
): 'new' | 'retry' | 'duplicate' {
  const existing = getWorkerRun(runId);
  if (existing) {
    if (existing.status === 'failed' || existing.status === 'failed_contract') {
      db.prepare(
        `UPDATE worker_runs
         SET status = 'queued',
             phase = 'queued',
             started_at = ?,
             completed_at = NULL,
             result_summary = NULL,
             error_details = NULL,
             branch_name = NULL,
             pr_url = NULL,
             commit_sha = NULL,
             files_changed = NULL,
             test_summary = NULL,
             risk_summary = NULL,
             dispatch_repo = NULL,
             dispatch_branch = NULL,
             request_id = NULL,
             context_intent = NULL,
             dispatch_payload = NULL,
             parent_run_id = NULL,
             dispatch_session_id = NULL,
             selected_session_id = NULL,
             effective_session_id = NULL,
             session_selection_source = NULL,
             session_resume_status = NULL,
             session_resume_error = NULL,
             last_heartbeat_at = NULL,
             spawn_acknowledged_at = NULL,
             active_container_name = NULL,
             no_container_since = NULL,
             expects_followup_container = 0,
             supervisor_owner = NULL,
             lease_expires_at = NULL,
             recovered_from_reason = NULL,
             retry_count = retry_count + 1
         WHERE run_id = ?`,
      ).run(new Date().toISOString(), runId);
      if (metadata) updateWorkerRunDispatchMetadata(runId, metadata);
      return 'retry';
    }
    return 'duplicate';
  }

  db.prepare(
    `INSERT INTO worker_runs (run_id, group_folder, lane_id, status, phase, started_at, retry_count)
     VALUES (?, ?, ?, 'queued', 'queued', ?, 0)`,
  ).run(runId, groupFolder, metadata?.lane_id ?? groupFolder, new Date().toISOString());
  if (metadata) updateWorkerRunDispatchMetadata(runId, metadata);
  return 'new';
}

export function updateWorkerRunDispatchMetadata(
  runId: string,
  metadata: WorkerRunDispatchMetadata,
): void {
  db.prepare(
    `UPDATE worker_runs
     SET dispatch_repo = ?,
         dispatch_branch = ?,
         request_id = ?,
         context_intent = ?,
         dispatch_payload = ?,
         parent_run_id = ?,
         dispatch_session_id = ?,
         selected_session_id = ?,
         session_selection_source = ?,
         lane_id = COALESCE(?, lane_id)
     WHERE run_id = ?`,
  ).run(
    metadata.dispatch_repo ?? null,
    metadata.dispatch_branch ?? null,
    metadata.request_id ?? null,
    metadata.context_intent ?? null,
    metadata.dispatch_payload ?? null,
    metadata.parent_run_id ?? null,
    metadata.dispatch_session_id ?? null,
    metadata.selected_session_id ?? null,
    metadata.session_selection_source ?? null,
    metadata.lane_id ?? null,
    runId,
  );
}

export function updateWorkerRunSessionMetadata(
  runId: string,
  metadata: WorkerRunSessionMetadata,
): void {
  db.prepare(
    `UPDATE worker_runs
     SET effective_session_id = ?,
         session_resume_status = ?,
         session_resume_error = ?
     WHERE run_id = ?`,
  ).run(
    metadata.effective_session_id ?? null,
    metadata.session_resume_status ?? null,
    metadata.session_resume_error ?? null,
    runId,
  );
}

export function updateWorkerRunLifecycle(
  runId: string,
  patch: WorkerRunLifecyclePatch,
): void {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];

  if (patch.phase !== undefined) {
    fields.push('phase = ?');
    values.push(patch.phase ?? null);
  }
  if (patch.last_heartbeat_at !== undefined) {
    fields.push('last_heartbeat_at = ?');
    values.push(patch.last_heartbeat_at ?? null);
  }
  if (patch.spawn_acknowledged_at !== undefined) {
    fields.push('spawn_acknowledged_at = ?');
    values.push(patch.spawn_acknowledged_at ?? null);
  }
  if (patch.active_container_name !== undefined) {
    fields.push('active_container_name = ?');
    values.push(patch.active_container_name ?? null);
  }
  if (patch.no_container_since !== undefined) {
    fields.push('no_container_since = ?');
    values.push(patch.no_container_since ?? null);
  }
  if (patch.expects_followup_container !== undefined) {
    fields.push('expects_followup_container = ?');
    values.push(
      patch.expects_followup_container === null
        ? null
        : patch.expects_followup_container
          ? 1
          : 0,
    );
  }
  if (patch.supervisor_owner !== undefined) {
    fields.push('supervisor_owner = ?');
    values.push(patch.supervisor_owner ?? null);
  }
  if (patch.lease_expires_at !== undefined) {
    fields.push('lease_expires_at = ?');
    values.push(patch.lease_expires_at ?? null);
  }
  if (patch.recovered_from_reason !== undefined) {
    fields.push('recovered_from_reason = ?');
    values.push(patch.recovered_from_reason ?? null);
  }

  if (fields.length === 0) return;

  values.push(runId);
  db.prepare(`UPDATE worker_runs SET ${fields.join(', ')} WHERE run_id = ?`).run(...values);
}

function getWorkerFailureReason(errorDetails: string | null): string | null {
  if (!errorDetails) return null;
  try {
    const parsed = JSON.parse(errorDetails) as { reason?: unknown };
    return typeof parsed.reason === 'string' ? parsed.reason : null;
  } catch {
    return null;
  }
}

function recoverWorkerRunForCompletionReason(
  runId: string,
  acceptedReasons: ReadonlySet<string>,
): { recovered: boolean; reason: string | null } {
  const run = getWorkerRun(runId);
  if (!run || (run.status !== 'failed' && run.status !== 'failed_contract')) {
    return { recovered: false, reason: null };
  }

  const reason = getWorkerFailureReason(run.error_details);
  if (!reason || !acceptedReasons.has(reason)) {
    return { recovered: false, reason };
  }

  db.prepare(
    `UPDATE worker_runs
     SET status = 'running',
         completed_at = NULL,
         result_summary = NULL,
         error_details = NULL,
         phase = 'finalizing',
         active_container_name = NULL,
         no_container_since = NULL,
         expects_followup_container = 0,
         lease_expires_at = NULL,
         recovered_from_reason = ?
     WHERE run_id = ?`,
  ).run(reason, runId);
  return { recovered: true, reason };
}

const COMPLETION_RECOVERABLE_FAILURE_REASONS = new Set([
  'running_without_container',
  'queued_stale_before_spawn',
  'stale_worker_run_watchdog',
  'active_status_with_completed_at',
]);

export function recoverWorkerRunForCompletionAccept(
  runId: string,
): { recovered: boolean; reason: string | null } {
  return recoverWorkerRunForCompletionReason(
    runId,
    COMPLETION_RECOVERABLE_FAILURE_REASONS,
  );
}

export function acceptWorkerRunCompletion(
  runId: string,
  data: {
    branch_name?: string;
    pr_url?: string;
    commit_sha?: string;
    files_changed?: string[];
    test_summary?: string;
    risk_summary?: string;
    effective_session_id?: string | null;
    session_resume_status?: string | null;
    session_resume_error?: string | null;
  },
): { ok: boolean; recovered: boolean } {
  return db.transaction((): { ok: boolean; recovered: boolean } => {
    const run = getWorkerRun(runId);
    if (!run) return { ok: false, recovered: false };

    let recovered = false;
    if (run.status === 'failed' || run.status === 'failed_contract') {
      const reason = getWorkerFailureReason(run.error_details);
      if (!reason || !COMPLETION_RECOVERABLE_FAILURE_REASONS.has(reason)) {
        return { ok: false, recovered: false };
      }
      db.prepare(
        `UPDATE worker_runs
         SET status = 'running',
             completed_at = NULL,
             result_summary = NULL,
             error_details = NULL,
             phase = 'finalizing',
             active_container_name = NULL,
             no_container_since = NULL,
             expects_followup_container = 0,
             lease_expires_at = NULL,
             recovered_from_reason = ?
         WHERE run_id = ?`,
      ).run(reason, runId);
      recovered = true;
    } else if (run.status !== 'running' && run.status !== 'queued') {
      return { ok: false, recovered: false };
    }

    db.prepare(
      `UPDATE worker_runs
       SET branch_name = ?,
           pr_url = ?,
           commit_sha = ?,
           files_changed = ?,
           test_summary = ?,
           risk_summary = ?,
           effective_session_id = COALESCE(?, effective_session_id),
           session_resume_status = COALESCE(?, session_resume_status),
           session_resume_error = COALESCE(?, session_resume_error)
       WHERE run_id = ?`,
    ).run(
      data.branch_name ?? null,
      data.pr_url ?? null,
      data.commit_sha ?? null,
      data.files_changed ? JSON.stringify(data.files_changed) : null,
      data.test_summary ?? null,
      data.risk_summary ?? null,
      data.effective_session_id ?? null,
      data.session_resume_status ?? null,
      data.session_resume_error ?? null,
      runId,
    );

    db.prepare(
      `UPDATE worker_runs
       SET status = 'review_requested',
           completed_at = COALESCE(completed_at, ?),
           phase = 'terminal',
           active_container_name = NULL,
           no_container_since = NULL,
           expects_followup_container = 0,
           lease_expires_at = NULL
       WHERE run_id = ? AND status IN ('running', 'queued')`,
    ).run(new Date().toISOString(), runId);

    return { ok: true, recovered };
  })();
}

export function recoverWorkerRunFromNoContainerFailure(runId: string): boolean {
  const result = recoverWorkerRunForCompletionReason(
    runId,
    new Set(['running_without_container']),
  );
  return result.recovered;
}

export function updateWorkerRunStatus(runId: string, status: WorkerRunStatus): void {
  const current = getWorkerRun(runId);
  if (!current) {
    logger.warn({ runId, status }, 'Ignored worker status update for unknown run');
    return;
  }

  const fromStatus = current.status as WorkerRunStatus;
  if (!canTransitionWorkerRunStatus(fromStatus, status)) {
    logger.warn(
      { runId, from: fromStatus, to: status },
      'Ignored invalid worker status transition',
    );
    return;
  }

  if (isTerminalWorkerRunStatus(status)) {
    db.prepare(
      `UPDATE worker_runs
       SET status = ?,
           completed_at = COALESCE(completed_at, ?),
           phase = 'terminal',
           active_container_name = NULL,
           no_container_since = NULL,
           expects_followup_container = 0,
           lease_expires_at = NULL
       WHERE run_id = ?`,
    ).run(status, new Date().toISOString(), runId);
  } else {
    if (status === 'running') {
      db.prepare(
        `UPDATE worker_runs
         SET status = ?,
             completed_at = NULL,
             phase = CASE
               WHEN phase IS NULL OR phase = '' OR phase = 'queued' OR phase = 'spawning' THEN 'active'
               ELSE phase
             END
         WHERE run_id = ?`,
      ).run(status, runId);
    } else {
      db.prepare(
        `UPDATE worker_runs SET status = ?, completed_at = NULL WHERE run_id = ?`,
      ).run(status, runId);
    }
  }
}

export function requeueWorkerRunForReplay(runId: string, reason: string): boolean {
  const run = getWorkerRun(runId);
  if (!run) return false;
  if (isTerminalWorkerRunStatus(run.status as WorkerRunStatus)) return false;

  db.prepare(
    `UPDATE worker_runs
     SET status = 'queued',
         phase = 'queued',
         completed_at = NULL,
         active_container_name = NULL,
         no_container_since = NULL,
         expects_followup_container = 0,
         supervisor_owner = NULL,
         lease_expires_at = NULL,
         recovered_from_reason = ?,
         error_details = NULL,
         result_summary = NULL,
         last_heartbeat_at = ?,
         retry_count = retry_count + 1
     WHERE run_id = ?`,
  ).run(reason, new Date().toISOString(), runId);
  return true;
}

export function updateWorkerRunCompletion(
  runId: string,
  data: {
    branch_name?: string;
    pr_url?: string;
    commit_sha?: string;
    files_changed?: string[];
    test_summary?: string;
    risk_summary?: string;
    effective_session_id?: string | null;
    session_resume_status?: 'resumed' | 'fallback_new' | 'new' | null;
    session_resume_error?: string | null;
  },
): void {
  db.prepare(
    `UPDATE worker_runs
     SET branch_name = ?,
         pr_url = ?,
         commit_sha = ?,
         files_changed = ?,
         test_summary = ?,
         risk_summary = ?,
         effective_session_id = COALESCE(?, effective_session_id),
         session_resume_status = COALESCE(?, session_resume_status),
         session_resume_error = COALESCE(?, session_resume_error)
     WHERE run_id = ?`,
  ).run(
    data.branch_name ?? null,
    data.pr_url ?? null,
    data.commit_sha ?? null,
    data.files_changed ? JSON.stringify(data.files_changed) : null,
    data.test_summary ?? null,
    data.risk_summary ?? null,
    data.effective_session_id ?? null,
    data.session_resume_status ?? null,
    data.session_resume_error ?? null,
    runId,
  );
}

export function completeWorkerRun(
  runId: string,
  status: WorkerRunStatus,
  resultSummary?: string,
  errorDetails?: string,
): void {
  const current = getWorkerRun(runId);
  if (!current) {
    logger.warn({ runId, status }, 'Ignored completeWorkerRun for unknown run');
    return;
  }

  if (!isTerminalWorkerRunStatus(status)) {
    logger.warn(
      { runId, status },
      'Ignored completeWorkerRun with non-terminal status',
    );
    return;
  }

  const fromStatus = current.status as WorkerRunStatus;
  if (!canTransitionWorkerRunStatus(fromStatus, status)) {
    logger.warn(
      { runId, from: fromStatus, to: status },
      'Ignored invalid worker completion transition',
    );
    return;
  }

  db.prepare(
    `UPDATE worker_runs
     SET status = ?,
         completed_at = ?,
         result_summary = ?,
         error_details = ?,
         phase = 'terminal',
         active_container_name = NULL,
         no_container_since = NULL,
         expects_followup_container = 0,
         lease_expires_at = NULL
     WHERE run_id = ?`,
  ).run(
    status,
    new Date().toISOString(),
    resultSummary ?? null,
    errorDetails ?? null,
    runId,
  );
}

export function getWorkerRun(runId: string): {
  run_id: string;
  group_folder: string;
  lane_id: string | null;
  status: string;
  phase: string | null;
  started_at: string;
  completed_at: string | null;
  retry_count: number;
  result_summary: string | null;
  error_details: string | null;
  branch_name: string | null;
  pr_url: string | null;
  commit_sha: string | null;
  files_changed: string | null;
  test_summary: string | null;
  risk_summary: string | null;
  dispatch_repo: string | null;
  dispatch_branch: string | null;
  request_id: string | null;
  context_intent: string | null;
  dispatch_payload: string | null;
  parent_run_id: string | null;
  dispatch_session_id: string | null;
  selected_session_id: string | null;
  effective_session_id: string | null;
  session_selection_source: string | null;
  session_resume_status: string | null;
  session_resume_error: string | null;
  last_heartbeat_at: string | null;
  spawn_acknowledged_at: string | null;
  active_container_name: string | null;
  no_container_since: string | null;
  expects_followup_container: number | null;
  supervisor_owner: string | null;
  lease_expires_at: string | null;
  recovered_from_reason: string | null;
} | undefined {
  return db
    .prepare(
      `SELECT run_id, group_folder, lane_id, status, phase, started_at, completed_at, retry_count, result_summary, error_details, branch_name, pr_url, commit_sha, files_changed, test_summary, risk_summary, dispatch_repo, dispatch_branch, request_id, context_intent, dispatch_payload, parent_run_id, dispatch_session_id, selected_session_id, effective_session_id, session_selection_source, session_resume_status, session_resume_error, last_heartbeat_at, spawn_acknowledged_at, active_container_name, no_container_since, expects_followup_container, supervisor_owner, lease_expires_at, recovered_from_reason
       FROM worker_runs
       WHERE run_id = ?`,
    )
    .get(runId) as ReturnType<typeof getWorkerRun>;
}

export function getWorkerRuns(options?: {
  groupFolderLike?: string;
  statuses?: WorkerRunStatus[];
  limit?: number;
}): WorkerRunRecord[] {
  const whereClauses: string[] = [];
  const params: Array<string | number> = [];

  if (options?.groupFolderLike) {
    whereClauses.push('group_folder LIKE ?');
    params.push(options.groupFolderLike);
  }

  if (options?.statuses && options.statuses.length > 0) {
    whereClauses.push(
      `status IN (${options.statuses.map(() => '?').join(', ')})`,
    );
    params.push(...options.statuses);
  }

  const where = whereClauses.length > 0
    ? `WHERE ${whereClauses.join(' AND ')}`
    : '';
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 500));

  params.push(limit);

  return db
    .prepare(
      `SELECT run_id, group_folder, lane_id, status, phase, started_at, completed_at, retry_count, result_summary, error_details, branch_name, pr_url, commit_sha, files_changed, test_summary, risk_summary, dispatch_repo, dispatch_branch, request_id, context_intent, dispatch_payload, parent_run_id, dispatch_session_id, selected_session_id, effective_session_id, session_selection_source, session_resume_status, session_resume_error, last_heartbeat_at, spawn_acknowledged_at, active_container_name, no_container_since, expects_followup_container, supervisor_owner, lease_expires_at, recovered_from_reason
       FROM worker_runs
       ${where}
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(...params) as WorkerRunRecord[];
}

export function getLatestReusableWorkerSession(
  groupFolder: string,
  repo: string,
  branch: string,
): WorkerRunRecord | undefined {
  return db.prepare(
    `SELECT run_id, group_folder, lane_id, status, phase, started_at, completed_at, retry_count, result_summary, error_details, branch_name, pr_url, commit_sha, files_changed, test_summary, risk_summary, dispatch_repo, dispatch_branch, request_id, context_intent, dispatch_payload, parent_run_id, dispatch_session_id, selected_session_id, effective_session_id, session_selection_source, session_resume_status, session_resume_error, last_heartbeat_at, spawn_acknowledged_at, active_container_name, no_container_since, expects_followup_container, supervisor_owner, lease_expires_at, recovered_from_reason
     FROM worker_runs
     WHERE group_folder = ?
       AND dispatch_repo = ?
       AND dispatch_branch = ?
       AND effective_session_id IS NOT NULL
       AND status IN ('review_requested', 'done')
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(groupFolder, repo, branch) as WorkerRunRecord | undefined;
}

export function findWorkerRunByEffectiveSessionId(sessionId: string): WorkerRunRecord | undefined {
  return db.prepare(
    `SELECT run_id, group_folder, lane_id, status, phase, started_at, completed_at, retry_count, result_summary, error_details, branch_name, pr_url, commit_sha, files_changed, test_summary, risk_summary, dispatch_repo, dispatch_branch, request_id, context_intent, dispatch_payload, parent_run_id, dispatch_session_id, selected_session_id, effective_session_id, session_selection_source, session_resume_status, session_resume_error, last_heartbeat_at, spawn_acknowledged_at, active_container_name, no_container_since, expects_followup_container, supervisor_owner, lease_expires_at, recovered_from_reason
     FROM worker_runs
     WHERE effective_session_id = ?
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(sessionId) as WorkerRunRecord | undefined;
}

// --- Per-message idempotency ---

export function isMessageProcessed(chatJid: string, messageId: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM processed_messages WHERE chat_jid = ? AND message_id = ?`,
  ).get(chatJid, messageId);
  return !!row;
}

/** Return the set of messageIds (from the given list) that have already been processed. */
export function getProcessedMessageIds(chatJid: string, messageIds: string[]): Set<string> {
  if (messageIds.length === 0) return new Set();
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT message_id FROM processed_messages WHERE chat_jid = ? AND message_id IN (${placeholders})`,
  ).all(chatJid, ...messageIds) as Array<{ message_id: string }>;
  return new Set(rows.map((r) => r.message_id));
}

export function markMessageProcessed(
  chatJid: string,
  messageId: string,
  runId?: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO processed_messages (chat_jid, message_id, processed_at, run_id)
     VALUES (?, ?, ?, ?)`,
  ).run(chatJid, messageId, new Date().toISOString(), runId ?? null);
}

export function markMessagesProcessed(
  chatJid: string,
  messageIds: string[],
  runId?: string,
): void {
  if (messageIds.length === 0) return;
  const now = new Date().toISOString();
  const runIdVal = runId ?? null;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO processed_messages (chat_jid, message_id, processed_at, run_id)
     VALUES (?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const id of messageIds) {
      insert.run(chatJid, id, now, runIdVal);
    }
  })();
}

function isTerminalAndyRequestState(state: AndyRequestState | string): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

export function createAndyRequestIfAbsent(input: {
  request_id: string;
  chat_jid: string;
  source_group_folder: string;
  source_lane_id?: string;
  user_message_id: string;
  user_prompt: string;
  intent: AndyRequestIntent;
  state?: AndyRequestState;
}): { request_id: string; created: boolean } {
  const existing = db.prepare(
    `SELECT request_id FROM andy_requests WHERE user_message_id = ?`,
  ).get(input.user_message_id) as { request_id: string } | undefined;
  if (existing) {
    return { request_id: existing.request_id, created: false };
  }

  const now = new Date().toISOString();
  const state = input.state ?? 'received';
  db.prepare(
    `INSERT INTO andy_requests (
      request_id,
      chat_jid,
      source_group_folder,
      source_lane_id,
      user_message_id,
      user_prompt,
      intent,
      state,
      created_at,
      updated_at,
      closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.request_id,
    input.chat_jid,
    input.source_group_folder,
    input.source_lane_id ?? input.source_group_folder,
    input.user_message_id,
    input.user_prompt,
    input.intent,
    state,
    now,
    now,
    isTerminalAndyRequestState(state) ? now : null,
  );

  return { request_id: input.request_id, created: true };
}

export function getAndyRequestByMessageId(messageId: string): AndyRequestRecord | undefined {
  return db.prepare(
    `SELECT request_id, chat_jid, source_group_folder, source_lane_id, user_message_id, user_prompt, intent, state, worker_run_id, worker_group_folder, coordinator_session_id, last_status_text, created_at, updated_at, closed_at
     FROM andy_requests
     WHERE user_message_id = ?`,
  ).get(messageId) as AndyRequestRecord | undefined;
}

export function getAndyRequestById(requestId: string): AndyRequestRecord | undefined {
  return db.prepare(
    `SELECT request_id, chat_jid, source_group_folder, source_lane_id, user_message_id, user_prompt, intent, state, worker_run_id, worker_group_folder, coordinator_session_id, last_status_text, created_at, updated_at, closed_at
     FROM andy_requests
     WHERE request_id = ?`,
  ).get(requestId) as AndyRequestRecord | undefined;
}

export function getLatestAndyRequestForChat(chatJid: string): AndyRequestRecord | undefined {
  return db.prepare(
    `SELECT request_id, chat_jid, source_group_folder, source_lane_id, user_message_id, user_prompt, intent, state, worker_run_id, worker_group_folder, coordinator_session_id, last_status_text, created_at, updated_at, closed_at
     FROM andy_requests
     WHERE chat_jid = ?
     ORDER BY updated_at DESC
     LIMIT 1`,
  ).get(chatJid) as AndyRequestRecord | undefined;
}

export function listActiveAndyRequests(chatJid: string, limit = 5): AndyRequestRecord[] {
  const boundedLimit = Math.max(1, Math.min(limit, 20));
  return db.prepare(
    `SELECT request_id, chat_jid, source_group_folder, source_lane_id, user_message_id, user_prompt, intent, state, worker_run_id, worker_group_folder, coordinator_session_id, last_status_text, created_at, updated_at, closed_at
     FROM andy_requests
     WHERE chat_jid = ? AND state NOT IN ('completed', 'failed', 'cancelled')
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).all(chatJid, boundedLimit) as AndyRequestRecord[];
}

export function updateAndyRequestState(
  requestId: string,
  state: AndyRequestState,
  lastStatusText?: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE andy_requests
     SET state = ?,
         last_status_text = COALESCE(?, last_status_text),
         updated_at = ?,
         closed_at = CASE
           WHEN ? IN ('completed', 'failed', 'cancelled') THEN COALESCE(closed_at, ?)
           ELSE NULL
         END
     WHERE request_id = ?`,
  ).run(
    state,
    lastStatusText ?? null,
    now,
    state,
    now,
    requestId,
  );
}

export function linkAndyRequestToWorkerRun(
  requestId: string,
  runId: string,
  workerGroupFolder: string,
  nextState: AndyRequestState = 'worker_queued',
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE andy_requests
     SET worker_run_id = ?,
         worker_group_folder = ?,
         state = ?,
         updated_at = ?,
         closed_at = NULL
     WHERE request_id = ?`,
  ).run(runId, workerGroupFolder, nextState, now, requestId);
}

export function updateAndyRequestByWorkerRun(
  runId: string,
  state: AndyRequestState,
  lastStatusText?: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE andy_requests
     SET state = ?,
         last_status_text = COALESCE(?, last_status_text),
         updated_at = ?,
         closed_at = CASE
           WHEN ? IN ('completed', 'failed', 'cancelled') THEN COALESCE(closed_at, ?)
           ELSE NULL
         END
     WHERE worker_run_id = ?`,
  ).run(
    state,
    lastStatusText ?? null,
    now,
    state,
    now,
    runId,
  );
}

export function setAndyRequestCoordinatorSession(
  requestId: string,
  sessionId: string | null,
): void {
  db.prepare(
    `UPDATE andy_requests
     SET coordinator_session_id = ?,
         updated_at = ?
     WHERE request_id = ?`,
  ).run(sessionId, new Date().toISOString(), requestId);
}

export function insertDispatchAttempt(input: {
  request_id?: string | null;
  source_lane_id: string;
  target_lane_id: string;
  run_id?: string | null;
  status: DispatchAttemptStatus;
  reason_code?: string | null;
  reason_text?: string | null;
  session_strategy?: string | null;
  dispatch_payload?: string | null;
}): string {
  const now = new Date().toISOString();
  const attemptId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO dispatch_attempts (
      attempt_id,
      request_id,
      source_lane_id,
      target_lane_id,
      run_id,
      status,
      reason_code,
      reason_text,
      session_strategy,
      dispatch_payload,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attemptId,
    input.request_id ?? null,
    input.source_lane_id,
    input.target_lane_id,
    input.run_id ?? null,
    input.status,
    input.reason_code ?? null,
    input.reason_text ?? null,
    input.session_strategy ?? null,
    input.dispatch_payload ?? null,
    now,
    now,
  );
  return attemptId;
}

export function listDispatchAttemptsForRequest(requestId: string): DispatchAttemptRecord[] {
  return db.prepare(
    `SELECT attempt_id, request_id, source_lane_id, target_lane_id, run_id, status, reason_code, reason_text, session_strategy, dispatch_payload, created_at, updated_at
     FROM dispatch_attempts
     WHERE request_id = ?
     ORDER BY created_at DESC`,
  ).all(requestId) as DispatchAttemptRecord[];
}

export function listDispatchAttemptsForRun(runId: string): DispatchAttemptRecord[] {
  return db.prepare(
    `SELECT attempt_id, request_id, source_lane_id, target_lane_id, run_id, status, reason_code, reason_text, session_strategy, dispatch_payload, created_at, updated_at
     FROM dispatch_attempts
     WHERE run_id = ?
     ORDER BY created_at DESC`,
  ).all(runId) as DispatchAttemptRecord[];
}

// --- Worker steering events ---

export function insertSteeringEvent(event: {
  steer_id: string;
  run_id: string;
  from_group: string;
  message: string;
  sent_at: string;
}): void {
  db.prepare(
    `INSERT OR IGNORE INTO worker_steering_events (steer_id, run_id, from_group, message, sent_at, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
  ).run(event.steer_id, event.run_id, event.from_group, event.message, event.sent_at);
  db.prepare(
    `UPDATE worker_runs SET steer_count = COALESCE(steer_count, 0) + 1 WHERE run_id = ?`,
  ).run(event.run_id);
}

export function ackSteeringEvent(steerId: string, ackedAt: string): void {
  db.prepare(
    `UPDATE worker_steering_events SET status = 'acked', acked_at = ? WHERE steer_id = ?`,
  ).run(ackedAt, steerId);
}

export function updateWorkerRunProgress(
  runId: string,
  summary: string,
  timestamp: string,
): void {
  db.prepare(
    `UPDATE worker_runs SET last_progress_summary = ?, last_progress_at = ? WHERE run_id = ?`,
  ).run(summary, timestamp, runId);
}

export function getWorkerRunProgress(
  runId: string,
): { last_progress_summary: string | null; last_progress_at: string | null } | null {
  return db
    .prepare(
      `SELECT last_progress_summary, last_progress_at FROM worker_runs WHERE run_id = ?`,
    )
    .get(runId) as { last_progress_summary: string | null; last_progress_at: string | null } | null;
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
