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
      group_folder TEXT NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'claude-code',
      session_id TEXT NOT NULL,
      PRIMARY KEY (group_folder, agent_type)
    );
    CREATE TABLE IF NOT EXISTS named_sessions (
      group_folder TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      session_label TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (group_folder, agent_type, session_label)
    );
    CREATE TABLE IF NOT EXISTS work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'produced',
      result_payload TEXT NOT NULL,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      CHECK (status IN ('produced', 'delivery_retry', 'delivered'))
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

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
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

  // Add paused_until column for /pause command support
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN paused_until TEXT`);
  } catch {
    /* column already exists */
  }

  // Migrate registered_groups to composite PK (jid, agent_type) — EJClaw-style paired room support
  {
    const rgCols = database
      .prepare('PRAGMA table_info(registered_groups)')
      .all() as Array<{ name: string }>;
    if (!rgCols.some((col) => col.name === 'agent_type')) {
      database.exec(`
        CREATE TABLE registered_groups_v2 (
          jid TEXT NOT NULL,
          name TEXT NOT NULL,
          folder TEXT NOT NULL,
          trigger_pattern TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          requires_trigger INTEGER DEFAULT 1,
          is_main INTEGER DEFAULT 0,
          paused_until TEXT,
          agent_type TEXT NOT NULL DEFAULT 'claude-code',
          PRIMARY KEY (jid, agent_type),
          UNIQUE (folder, agent_type)
        );
        INSERT INTO registered_groups_v2 (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, paused_until, agent_type)
        SELECT
          jid, name, folder, trigger_pattern, added_at, container_config,
          COALESCE(requires_trigger, 1),
          COALESCE(is_main, 0),
          paused_until,
          CASE
            WHEN json_extract(container_config, '$.agentCli') = 'gemini'  THEN 'gemini'
            WHEN json_extract(container_config, '$.agentCli') = 'copilot' THEN 'copilot'
            WHEN json_extract(container_config, '$.agentCli') = 'codex'   THEN 'codex'
            ELSE 'claude-code'
          END
        FROM registered_groups;
        DROP TABLE registered_groups;
        ALTER TABLE registered_groups_v2 RENAME TO registered_groups;
      `);
    }
  }

  // Backfill paused_until again after the registered_groups table rewrite above.
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN paused_until TEXT`);
  } catch {
    /* column already exists */
  }

  // Migrate sessions to composite PK (group_folder, agent_type)
  {
    const sessionCols = database
      .prepare('PRAGMA table_info(sessions)')
      .all() as Array<{ name: string }>;
    if (!sessionCols.some((col) => col.name === 'agent_type')) {
      database.exec(`
        ALTER TABLE sessions RENAME TO sessions_old;
        CREATE TABLE sessions (
          group_folder TEXT NOT NULL,
          agent_type TEXT NOT NULL DEFAULT 'claude-code',
          session_id TEXT NOT NULL,
          PRIMARY KEY (group_folder, agent_type)
        );
        INSERT INTO sessions (group_folder, agent_type, session_id)
          SELECT group_folder, 'claude-code', session_id FROM sessions_old;
        DROP TABLE sessions_old;
      `);
    }
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
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
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

export function getRecentMessages(
  chatJid: string,
  limit: number = 12,
): Array<
  Pick<
    NewMessage,
    'id' | 'chat_jid' | 'sender' | 'sender_name' | 'content' | 'timestamp'
  > & { is_bot_message?: boolean }
> {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_bot_message
      FROM messages
      WHERE chat_jid = ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db.prepare(sql).all(chatJid, limit) as Array<
    Pick<
      NewMessage,
      'id' | 'chat_jid' | 'sender' | 'sender_name' | 'content' | 'timestamp'
    > & { is_bot_message?: boolean }
  >;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
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
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
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

/** Get session ID for any agent type. */
export function getAgentSession(
  groupFolder: string,
  agentType: string,
): string | undefined {
  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE group_folder = ? AND agent_type = ?',
    )
    .get(groupFolder, agentType) as { session_id: string } | undefined;
  return row?.session_id;
}

/** Store session ID for any agent type. */
export function setAgentSession(
  groupFolder: string,
  agentType: string,
  sessionId: string,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, agent_type, session_id) VALUES (?, ?, ?)',
  ).run(groupFolder, agentType, sessionId);
}

export function deleteAgentSession(
  groupFolder: string,
  agentType: string,
): void {
  db.prepare(
    'DELETE FROM sessions WHERE group_folder = ? AND agent_type = ?',
  ).run(groupFolder, agentType);
}

export interface NamedSession {
  session_label: string;
  session_id: string;
  updated_at: string;
}

export function getNamedAgentSession(
  groupFolder: string,
  agentType: string,
  sessionLabel: string,
): NamedSession | undefined {
  return db
    .prepare(
      `SELECT session_label, session_id, updated_at
       FROM named_sessions
       WHERE group_folder = ? AND agent_type = ? AND session_label = ?`,
    )
    .get(groupFolder, agentType, sessionLabel) as NamedSession | undefined;
}

export function getNamedAgentSessions(
  groupFolder: string,
  agentType: string,
): NamedSession[] {
  return db
    .prepare(
      `SELECT session_label, session_id, updated_at
       FROM named_sessions
       WHERE group_folder = ? AND agent_type = ?
       ORDER BY updated_at DESC, session_label ASC`,
    )
    .all(groupFolder, agentType) as NamedSession[];
}

export function setNamedAgentSession(
  groupFolder: string,
  agentType: string,
  sessionLabel: string,
  sessionId: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO named_sessions
     (group_folder, agent_type, session_label, session_id, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    groupFolder,
    agentType,
    sessionLabel,
    sessionId,
    new Date().toISOString(),
  );
}

function activeSessionLabelKey(groupFolder: string, agentType: string): string {
  return `active_session_label:${groupFolder}:${agentType}`;
}

export function getActiveAgentSessionLabel(
  groupFolder: string,
  agentType: string,
): string | undefined {
  return getRouterState(activeSessionLabelKey(groupFolder, agentType));
}

export function setActiveAgentSessionLabel(
  groupFolder: string,
  agentType: string,
  sessionLabel: string,
): void {
  setRouterState(activeSessionLabelKey(groupFolder, agentType), sessionLabel);
}

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare(
      'SELECT session_id FROM sessions WHERE group_folder = ? AND agent_type = ?',
    )
    .get(groupFolder, 'claude-code') as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, agent_type, session_id) VALUES (?, ?, ?)',
  ).run(groupFolder, 'claude-code', sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare(
      'SELECT group_folder, session_id FROM sessions WHERE agent_type = ?',
    )
    .all('claude-code') as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

type RawGroupRow = {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number | null;
  is_main: number | null;
  agent_type: string | null;
  paused_until: string | null;
};

function rowToGroup(row: RawGroupRow): RegisteredGroup {
  return {
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
    agentType: row.agent_type ?? 'claude-code',
    pausedUntil: row.paused_until ?? undefined,
  };
}

export function getRegisteredGroup(
  jid: string,
  agentType = 'claude-code',
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ? AND agent_type = ?')
    .get(jid, agentType) as RawGroupRow | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return { jid: row.jid, ...rowToGroup(row) };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  const agentType = group.agentType ?? 'claude-code';
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, agent_type, paused_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    agentType,
    group.pausedUntil ?? null,
  );
}

export function deleteRegisteredGroup(jid: string, agentType: string): void {
  db.prepare(
    'DELETE FROM registered_groups WHERE jid = ? AND agent_type = ?',
  ).run(jid, agentType);
}

/**
 * Load all registered groups, optionally filtered by agent_type.
 * For paired rooms the same JID can appear multiple times (once per agent_type).
 * Returns Record<jid, RegisteredGroup> using the FIRST matching row per JID
 * when no filter is supplied (backwards-compat), or exactly the filtered set.
 */
export function getAllRegisteredGroups(
  agentTypeFilter?: string,
): Record<string, RegisteredGroup> {
  const rows = (
    agentTypeFilter
      ? db
          .prepare('SELECT * FROM registered_groups WHERE agent_type = ?')
          .all(agentTypeFilter)
      : db.prepare('SELECT * FROM registered_groups').all()
  ) as RawGroupRow[];

  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    // When no filter: first row wins per JID (prefer claude-code, then others)
    if (!agentTypeFilter && result[row.jid]) continue;
    result[row.jid] = rowToGroup(row);
  }
  return result;
}

/**
 * Returns true if the JID has more than one agent_type registered (paired room).
 */
export function isPairedRoomJid(jid: string): boolean {
  return getRegisteredAgentTypesForJid(jid).length > 1;
}

/**
 * Returns all agent_types registered for a JID.
 * More than one entry means this is a paired room.
 */
export function getRegisteredAgentTypesForJid(jid: string): string[] {
  const rows = db
    .prepare('SELECT agent_type FROM registered_groups WHERE jid = ?')
    .all(jid) as Array<{ agent_type: string }>;
  return rows.map((r) => r.agent_type);
}

/**
 * Returns ALL group registrations for a JID (one per agent_type).
 */
export function getAllGroupsForJid(jid: string): RegisteredGroup[] {
  const rows = db
    .prepare(
      'SELECT * FROM registered_groups WHERE jid = ? ORDER BY agent_type',
    )
    .all(jid) as RawGroupRow[];
  return rows.filter((r) => isValidGroupFolder(r.folder)).map(rowToGroup);
}

// --- Pause accessors ---

/** Set or clear the pause timestamp for a specific agent in a channel. */
export function setGroupPause(
  jid: string,
  agentType: string,
  pausedUntil: string | null,
): void {
  db.prepare(
    'UPDATE registered_groups SET paused_until = ? WHERE jid = ? AND agent_type = ?',
  ).run(pausedUntil, jid, agentType);
}

/** Returns true if the agent is currently paused (pausedUntil is in the future). */
export function isGroupPaused(jid: string, agentType: string): boolean {
  const row = db
    .prepare(
      'SELECT paused_until FROM registered_groups WHERE jid = ? AND agent_type = ?',
    )
    .get(jid, agentType) as { paused_until: string | null } | undefined;
  if (!row?.paused_until) return false;
  return new Date() < new Date(row.paused_until);
}

// --- Work item accessors ---

export interface WorkItem {
  id: number;
  group_folder: string;
  chat_jid: string;
  agent_type: string;
  status: 'produced' | 'delivery_retry' | 'delivered';
  result_payload: string;
  delivery_attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export function createWorkItem(
  item: Pick<
    WorkItem,
    'group_folder' | 'chat_jid' | 'agent_type' | 'result_payload'
  >,
): number {
  const result = db
    .prepare(
      `INSERT INTO work_items (group_folder, chat_jid, agent_type, result_payload) VALUES (?, ?, ?, ?)`,
    )
    .run(
      item.group_folder,
      item.chat_jid,
      item.agent_type,
      item.result_payload,
    );
  return result.lastInsertRowid as number;
}

export function markWorkItemDelivered(id: number): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE work_items SET status = 'delivered', delivered_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now, now, id);
}

export function markWorkItemFailed(id: number, error: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE work_items SET status = 'delivery_retry', delivery_attempts = delivery_attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(error, now, id);
}

export function getUndeliveredWorkItems(): WorkItem[] {
  return db
    .prepare(
      `SELECT * FROM work_items WHERE status IN ('produced', 'delivery_retry') ORDER BY created_at`,
    )
    .all() as WorkItem[];
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
