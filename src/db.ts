import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  BacklogItem,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  ShipLogEntry,
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
      folder TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // sessions_v2: thread-aware session management (additive, does NOT drop sessions table)
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions_v2 (
      session_key TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      thread_id TEXT,
      session_id TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_v2_group ON sessions_v2(group_folder);
    CREATE INDEX IF NOT EXISTS idx_sessions_v2_activity ON sessions_v2(last_activity);
  `);

  // Add model column to sessions_v2 (sticky model override per session)
  try {
    database.exec(`ALTER TABLE sessions_v2 ADD COLUMN model TEXT DEFAULT NULL`);
  } catch {
    // Column already exists — ignore
  }

  // Add processing flag to sessions_v2 (tracks in-flight agent runs)
  try {
    database.exec(
      `ALTER TABLE sessions_v2 ADD COLUMN processing INTEGER DEFAULT 0`,
    );
  } catch {
    // Column already exists — ignore
  }

  // Add chat_jid column to sessions_v2 (identifies the channel for recovery notices)
  try {
    database.exec(`ALTER TABLE sessions_v2 ADD COLUMN chat_jid TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Add effort column to sessions_v2 (sticky effort override per session)
  try {
    database.exec(
      `ALTER TABLE sessions_v2 ADD COLUMN effort TEXT DEFAULT NULL`,
    );
  } catch {
    // Column already exists — ignore
  }

  // Index for thread LIKE queries in getNewMessages (e.g. chat_jid LIKE 'slack:C123:thread:%')
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_jid, timestamp)`,
  );

  // Discord thread origin persistence — maps thread channel IDs to their
  // originating message so thread replies find the correct session after restart.
  database.exec(`
    CREATE TABLE IF NOT EXISTS thread_origins (
      thread_channel_id TEXT PRIMARY KEY,
      origin_message_id TEXT NOT NULL,
      parent_jid TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Thread search: FTS5 full-text search + metadata for cross-thread search (Plan C)
  // FTS5 indexes only thread_key + topic_summary. Group scoping is enforced
  // by joining with thread_metadata.group_folder (not via FTS5 column).
  database.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS thread_search USING fts5(
      thread_key UNINDEXED,
      topic_summary
    );

    CREATE TABLE IF NOT EXISTS thread_metadata (
      thread_key TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      topic_summary TEXT,
      created_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      indexed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_thread_meta_group ON thread_metadata(group_folder);
  `);

  // Ship log and backlog for tracking shipped features and open issues
  database.exec(`
    CREATE TABLE IF NOT EXISTS ship_log (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL DEFAULT 'main',
      title TEXT NOT NULL,
      description TEXT,
      pr_url TEXT,
      branch TEXT,
      tags TEXT,
      shipped_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ship_log_shipped_at ON ship_log(shipped_at);

    CREATE TABLE IF NOT EXISTS backlog (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL DEFAULT 'main',
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'medium',
      tags TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_backlog_status ON backlog(status);
    CREATE INDEX IF NOT EXISTS idx_backlog_priority ON backlog(priority);
  `);

  // Add group_folder to ship_log (scopes entries per group)
  try {
    database.exec(
      `ALTER TABLE ship_log ADD COLUMN group_folder TEXT NOT NULL DEFAULT 'main'`,
    );
  } catch {
    // Column already exists — ignore
  }

  // Add group_folder to backlog (scopes entries per group)
  try {
    database.exec(
      `ALTER TABLE backlog ADD COLUMN group_folder TEXT NOT NULL DEFAULT 'main'`,
    );
  } catch {
    // Column already exists — ignore
  }

  // Group-folder indexes — must come AFTER the ALTER TABLE migrations
  // (old tables may not have group_folder yet)
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_ship_log_group ON ship_log(group_folder);
    CREATE INDEX IF NOT EXISTS idx_backlog_group ON backlog(group_folder);
  `);

  // Migrate existing sessions into sessions_v2 (skip if already migrated)
  const v2Count = (
    database.prepare('SELECT COUNT(*) AS c FROM sessions_v2').get() as {
      c: number;
    }
  ).c;
  if (v2Count === 0) {
    const existingSessions = database
      .prepare('SELECT group_folder, session_id FROM sessions')
      .all() as Array<{ group_folder: string; session_id: string }>;
    if (existingSessions.length > 0) {
      const migrateV2 = database.transaction(() => {
        const now = new Date().toISOString();
        const insert = database.prepare(
          `INSERT OR IGNORE INTO sessions_v2 (session_key, group_folder, thread_id, session_id, last_activity, created_at)
           VALUES (?, ?, NULL, ?, ?, ?)`,
        );
        for (const row of existingSessions) {
          insert.run(
            row.group_folder,
            row.group_folder,
            row.session_id,
            now,
            now,
          );
        }
      });
      migrateV2();
    }
  }

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

  // Drop UNIQUE constraint on folder — multiple channels can share the same workspace
  // (e.g. all Slack channels in a workspace using the same group folder).
  // SQLite doesn't support DROP CONSTRAINT, so we recreate the table.
  try {
    const hasUnique = database
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='registered_groups'`,
      )
      .get() as { sql: string } | undefined;
    if (hasUnique?.sql?.includes('UNIQUE')) {
      database.exec(`
        CREATE TABLE registered_groups_new (
          jid TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder TEXT NOT NULL,
          trigger_pattern TEXT NOT NULL,
          added_at TEXT NOT NULL,
          container_config TEXT,
          requires_trigger INTEGER DEFAULT 1,
          is_main INTEGER DEFAULT 0
        );
        INSERT INTO registered_groups_new SELECT * FROM registered_groups;
        DROP TABLE registered_groups;
        ALTER TABLE registered_groups_new RENAME TO registered_groups;
      `);
    }
  } catch {
    /* migration already applied or table doesn't exist yet */
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
 * Check whether a user message with the given exact timestamp exists in a JID.
 * Used during startup to detect cursors that are stuck at a message boundary
 * due to a SIGTERM killing the container before it could respond.
 */
export function hasUserMessageAtTimestamp(
  chatJid: string,
  timestamp: string,
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM messages WHERE chat_jid = ? AND timestamp = ? AND is_bot_message = 0 LIMIT 1`,
    )
    .get(chatJid, timestamp);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
// Cache of thread JIDs we've already ensured have a chats row,
// avoiding a redundant INSERT OR IGNORE on every thread message.
const knownThreadChats = new Set<string>();

/** Derive channel name from a JID prefix. */
function channelFromJid(jid: string): string {
  const prefix = jid.split(':')[0];
  return prefix || 'unknown';
}

/** Ensure a chats row exists for the given JID (idempotent). */
function ensureChatExists(jid: string, timestamp: string): void {
  if (knownThreadChats.has(jid)) return;
  db.prepare(
    `INSERT OR IGNORE INTO chats (jid, last_message_time, channel, is_group) VALUES (?, ?, ?, 1)`,
  ).run(jid, timestamp, channelFromJid(jid));
  knownThreadChats.add(jid);
}

export function storeMessage(msg: NewMessage): void {
  // Thread JIDs (e.g. slack:C123:thread:ts) may not have a chats row yet.
  // Auto-create one to satisfy the foreign key on messages.chat_jid.
  if (msg.chat_jid.includes(':thread:')) {
    ensureChatExists(msg.chat_jid, msg.timestamp);
  }

  const insertStmt = db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const params = [
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  ];

  try {
    insertStmt.run(...params);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('FOREIGN KEY')) {
      // Auto-create missing chats entry and retry — prevents message loss
      // when the chats row is missing (e.g. race condition, stale DB state).
      ensureChatExists(msg.chat_jid, msg.timestamp);
      logger.warn(
        { chat_jid: msg.chat_jid },
        'Auto-created missing chats entry on FK constraint failure',
      );
      insertStmt.run(...params);
    } else {
      throw err;
    }
  }
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

  // Build a WHERE clause that matches both exact JIDs and their thread variants.
  // Thread messages are stored as dc:{parent}:thread:{id} or slack:{channel}:thread:{ts}.
  const conditions: string[] = [];
  const params: string[] = [lastTimestamp];

  // Exact match for all JIDs
  const placeholders = jids.map(() => '?').join(',');
  conditions.push(`chat_jid IN (${placeholders})`);
  params.push(...jids);

  // LIKE match for thread-capable channels (dc: and slack:)
  for (const jid of jids) {
    if (jid.startsWith('dc:') || jid.startsWith('slack:')) {
      conditions.push('chat_jid LIKE ?');
      params.push(`${jid}:thread:%`);
    }
  }

  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND (${conditions.join(' OR ')})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  params.push(`${botPrefix}:%`, String(limit));
  const rows = db.prepare(sql).all(...params) as NewMessage[];

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
  // Bot messages are excluded here to prevent re-trigger loops;
  // use getBotResponsesSince() to fetch them separately for prompt context.
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

/** Max characters to include for bot responses in prompt context.
 *  Long bot responses are truncated to save tokens while preserving awareness. */
const BOT_RESPONSE_CONTEXT_LIMIT = 500;

/**
 * Fetch bot responses in a time range, truncated for prompt context.
 * Used to interleave the agent's prior responses into the conversation
 * so it knows what it said. Separate from getMessagesSince to avoid
 * re-trigger loops (bot messages should not trigger processing).
 */
export function getBotResponsesSince(
  chatJid: string,
  sinceTimestamp: string,
): NewMessage[] {
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 1
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
    LIMIT 50
  `;
  const rows = db.prepare(sql).all(chatJid, sinceTimestamp) as NewMessage[];

  for (const row of rows) {
    if (row.content.length > BOT_RESPONSE_CONTEXT_LIMIT) {
      row.content =
        row.content.slice(0, BOT_RESPONSE_CONTEXT_LIMIT) + '\n... [truncated]';
    }
  }

  return rows;
}

/**
 * Get a message by its ID and chat JID.
 */
export function getMessageById(
  id: string,
  chatJid: string,
): NewMessage | undefined {
  return db
    .prepare(
      `SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
       FROM messages WHERE id = ? AND chat_jid = ?`,
    )
    .get(id, chatJid) as NewMessage | undefined;
}

/** Ensure a sessions_v2 row exists (creates a stub if needed). */
function ensureSessionRow(
  sessionKey: string,
  groupFolder: string,
  threadId?: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO sessions_v2 (session_key, group_folder, thread_id, session_id, last_activity, created_at)
     VALUES (?, ?, ?, '', ?, ?)`,
  ).run(sessionKey, groupFolder, threadId || null, now, now);
}

/** Mark a session as in-flight (processing started).
 *  Creates a stub row if needed (new threads don't have a sessions_v2 row yet).
 *  Stores chat_jid so recovery can send notices to the correct channel. */
export function setSessionProcessing(
  sessionKey: string,
  groupFolder: string,
  chatJid: string,
  threadId?: string,
): void {
  ensureSessionRow(sessionKey, groupFolder, threadId);
  db.prepare(
    'UPDATE sessions_v2 SET processing = 1, chat_jid = ? WHERE session_key = ?',
  ).run(chatJid, sessionKey);
}

/** Clear in-flight flag (processing completed or errored). */
export function clearSessionProcessing(sessionKey: string): void {
  db.prepare('UPDATE sessions_v2 SET processing = 0 WHERE session_key = ?').run(
    sessionKey,
  );
}

/**
 * Find all threads that were mid-processing when the service stopped.
 * Returns thread_id + chat_jid so recovery can send notices to the correct channel.
 */
export function findAllInFlightThreads(): Array<{
  thread_id: string;
  chat_jid: string;
  group_folder: string;
}> {
  return db
    .prepare(
      `SELECT thread_id, chat_jid, group_folder FROM sessions_v2
       WHERE thread_id IS NOT NULL AND processing = 1
         AND chat_jid IS NOT NULL`,
    )
    .all() as Array<{
    thread_id: string;
    chat_jid: string;
    group_folder: string;
  }>;
}

/** Clear all processing flags (safety reset on startup). */
export function clearAllProcessingFlags(): void {
  db.prepare(
    'UPDATE sessions_v2 SET processing = 0 WHERE processing = 1',
  ).run();
}

// --- Thread origin accessors (Discord thread → session mapping) ---

export function setThreadOrigin(
  threadChannelId: string,
  originMessageId: string,
  parentJid: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO thread_origins (thread_channel_id, origin_message_id, parent_jid, created_at) VALUES (?, ?, ?, ?)',
  ).run(threadChannelId, originMessageId, parentJid, now);
}

export function getThreadOrigin(
  threadChannelId: string,
): { origin_message_id: string; parent_jid: string } | undefined {
  return db
    .prepare(
      'SELECT origin_message_id, parent_jid FROM thread_origins WHERE thread_channel_id = ?',
    )
    .get(threadChannelId) as
    | { origin_message_id: string; parent_jid: string }
    | undefined;
}

/**
 * Delete thread_origins entries older than the given cutoff timestamp.
 * Called during session sweep to prevent unbounded table growth.
 */
export function pruneThreadOrigins(cutoffIso: string): number {
  const result = db
    .prepare('DELETE FROM thread_origins WHERE created_at < ?')
    .run(cutoffIso);
  return result.changes;
}

/**
 * Get all messages in a thread (or channel), including bot replies.
 * Used by IPC read_thread queries so container agents can see full conversations.
 */
export function getThreadMessages(
  chatJid: string,
  limit: number = 100,
): Array<{
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
}> {
  return db
    .prepare(
      `SELECT sender_name, content, timestamp, is_from_me
       FROM messages
       WHERE chat_jid = ? AND content != '' AND content IS NOT NULL
       ORDER BY timestamp
       LIMIT ?`,
    )
    .all(chatJid, limit) as Array<{
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: number;
  }>;
}

/**
 * Look up a single message by its platform-specific ID across all chats.
 * Used when we have a message ID but don't know the chat_jid (e.g., Discord link).
 */
export function findMessageById(id: string):
  | {
      chat_jid: string;
      timestamp: string;
      sender_name: string;
      content: string;
    }
  | undefined {
  return db
    .prepare(
      `SELECT chat_jid, timestamp, sender_name, content FROM messages WHERE id = ? LIMIT 1`,
    )
    .get(id) as
    | {
        chat_jid: string;
        timestamp: string;
        sender_name: string;
        content: string;
      }
    | undefined;
}

/**
 * Get messages from a chat_jid centered around a given timestamp.
 * Returns `limit` messages: half before, half after (or as many as exist).
 */
export function getMessagesAroundTimestamp(
  chatJid: string,
  timestamp: string,
  limit: number = 50,
): Array<{
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
}> {
  const half = Math.ceil(limit / 2);
  // Get messages before (inclusive) and after the timestamp, then merge
  const before = db
    .prepare(
      `SELECT sender_name, content, timestamp, is_from_me
       FROM messages
       WHERE chat_jid = ? AND timestamp <= ? AND content != '' AND content IS NOT NULL
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(chatJid, timestamp, half) as Array<{
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: number;
  }>;

  const after = db
    .prepare(
      `SELECT sender_name, content, timestamp, is_from_me
       FROM messages
       WHERE chat_jid = ? AND timestamp > ? AND content != '' AND content IS NOT NULL
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(chatJid, timestamp, half) as Array<{
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: number;
  }>;

  return [...before.reverse(), ...after];
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

// --- Session accessors (V1 — kept for upstream merge safety) ---

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

// --- Session V2 accessors (thread-aware) ---

export interface SessionV2Row {
  session_key: string;
  group_folder: string;
  thread_id: string | null;
  session_id: string;
  last_activity: string;
  created_at: string;
}

export function buildSessionKey(
  groupFolder: string,
  threadId?: string,
): string {
  return threadId ? `${groupFolder}:thread:${threadId}` : groupFolder;
}

export function parseSessionKey(key: string): {
  groupFolder: string;
  threadId?: string;
} {
  const match = key.match(/^(.+?):thread:(.+)$/);
  if (match) return { groupFolder: match[1], threadId: match[2] };
  return { groupFolder: key };
}

export function getSessionV2(
  key: string,
): { session_id: string; last_activity: string } | undefined {
  return db
    .prepare(
      'SELECT session_id, last_activity FROM sessions_v2 WHERE session_key = ?',
    )
    .get(key) as { session_id: string; last_activity: string } | undefined;
}

export function setSessionV2(
  key: string,
  groupFolder: string,
  sessionId: string,
  threadId?: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions_v2 (session_key, group_folder, thread_id, session_id, last_activity, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_key) DO UPDATE SET
       session_id = excluded.session_id,
       last_activity = excluded.last_activity`,
  ).run(key, groupFolder, threadId || null, sessionId, now, now);
}

/** Throttled last_activity update — caller is responsible for throttling. */
export function touchSessionActivity(key: string): void {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE sessions_v2 SET last_activity = ? WHERE session_key = ?',
  ).run(now, key);
}

export function deleteSessionV2(key: string): void {
  db.prepare('DELETE FROM sessions_v2 WHERE session_key = ?').run(key);
}

/** Get the sticky model override for a session, if any. */
export function getSessionModel(key: string): string | undefined {
  const row = db
    .prepare('SELECT model FROM sessions_v2 WHERE session_key = ?')
    .get(key) as { model: string | null } | undefined;
  return row?.model ?? undefined;
}

/** Set or clear the sticky model override for a session.
 *  When groupFolder is provided, creates a stub row if one doesn't exist yet
 *  (the bare UPDATE would silently affect 0 rows for new sessions). */
export function setSessionModel(
  key: string,
  model: string | null,
  groupFolder?: string,
  threadId?: string,
): void {
  if (groupFolder && model !== null) {
    ensureSessionRow(key, groupFolder, threadId);
  }
  db.prepare('UPDATE sessions_v2 SET model = ? WHERE session_key = ?').run(
    model,
    key,
  );
}

/** Get the sticky effort override for a session, if any. */
export function getSessionEffort(key: string): string | undefined {
  const row = db
    .prepare('SELECT effort FROM sessions_v2 WHERE session_key = ?')
    .get(key) as { effort: string | null } | undefined;
  return row?.effort ?? undefined;
}

/** Set or clear the sticky effort override for a session. */
export function setSessionEffort(
  key: string,
  effort: string | null,
  groupFolder?: string,
  threadId?: string,
): void {
  if (groupFolder && effort !== null) {
    ensureSessionRow(key, groupFolder, threadId);
  }
  db.prepare('UPDATE sessions_v2 SET effort = ? WHERE session_key = ?').run(
    effort,
    key,
  );
}

export function getIdleSessions(cutoffISO: string): SessionV2Row[] {
  return db
    .prepare('SELECT * FROM sessions_v2 WHERE last_activity < ?')
    .all(cutoffISO) as SessionV2Row[];
}

export function getThreadSessions(groupFolder: string): SessionV2Row[] {
  return db
    .prepare(
      'SELECT * FROM sessions_v2 WHERE group_folder = ? AND thread_id IS NOT NULL',
    )
    .all(groupFolder) as SessionV2Row[];
}

export function getAllSessionsV2(): Map<string, string> {
  const rows = db
    .prepare('SELECT session_key, session_id FROM sessions_v2')
    .all() as Array<{ session_key: string; session_id: string }>;
  const result = new Map<string, string>();
  for (const row of rows) {
    result.set(row.session_key, row.session_id);
  }
  return result;
}

// --- Thread search accessors (Plan C: FTS5 + Haiku reranking) ---

export interface ThreadMetadataRow {
  thread_key: string;
  group_folder: string;
  thread_id: string;
  platform: string;
  topic_summary: string | null;
  created_at: string;
  last_activity: string;
  indexed_at: string | null;
}

/** Returns true if the index was actually updated, false if skipped (unchanged). */
export function upsertThreadIndex(
  threadKey: string,
  groupFolder: string,
  threadId: string,
  platform: string,
  summary: string,
): boolean {
  const now = new Date().toISOString();

  // Check if already indexed with the same summary (skip re-index)
  const existing = db
    .prepare('SELECT topic_summary FROM thread_metadata WHERE thread_key = ?')
    .get(threadKey) as { topic_summary: string | null } | undefined;

  if (existing?.topic_summary === summary) return false;

  db.transaction(() => {
    // Remove old FTS5 entry if exists, then re-insert with updated summary
    if (existing) {
      db.prepare('DELETE FROM thread_search WHERE thread_key = ?').run(
        threadKey,
      );
    }

    // Insert into FTS5
    db.prepare(
      'INSERT INTO thread_search (thread_key, topic_summary) VALUES (?, ?)',
    ).run(threadKey, summary);

    // Upsert metadata
    db.prepare(
      `INSERT INTO thread_metadata (thread_key, group_folder, thread_id, platform, topic_summary, created_at, last_activity, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_key) DO UPDATE SET
         topic_summary = excluded.topic_summary,
         last_activity = excluded.last_activity,
         indexed_at = excluded.indexed_at`,
    ).run(threadKey, groupFolder, threadId, platform, summary, now, now, now);
  })();

  return true;
}

export function searchThreadsFTS(
  groupFolder: string,
  query: string,
  limit: number = 20,
): ThreadMetadataRow[] {
  // FTS5 MATCH on topic_summary, group scoping via metadata join
  return db
    .prepare(
      `SELECT m.* FROM thread_search s
       JOIN thread_metadata m ON m.thread_key = s.thread_key
       WHERE s.topic_summary MATCH ? AND m.group_folder = ?
       ORDER BY s.rank
       LIMIT ?`,
    )
    .all(query, groupFolder, limit) as ThreadMetadataRow[];
}

export function getThreadMetadata(
  threadKey: string,
): ThreadMetadataRow | undefined {
  return db
    .prepare('SELECT * FROM thread_metadata WHERE thread_key = ?')
    .get(threadKey) as ThreadMetadataRow | undefined;
}

export function getRecentMessages(
  chatJid: string,
  limit: number,
): Array<{ content: string; is_from_me: boolean; timestamp: string }> {
  return db
    .prepare(
      `SELECT content, is_from_me, timestamp FROM messages
       WHERE chat_jid = ? AND content != '' AND content IS NOT NULL
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(chatJid, limit) as Array<{
    content: string;
    is_from_me: boolean;
    timestamp: string;
  }>;
}

/**
 * Fallback: search raw message content for a group's threads when FTS returns 0.
 * Uses a single JOIN across sessions_v2 and messages — one DB round-trip instead of N+1.
 * Sessions subquery is capped at 100 to avoid unbounded scans for large groups.
 * Returns at most `limit` matching thread+snippet pairs, one per thread_id.
 */
export function searchMessagesRaw(
  groupFolder: string,
  words: string[],
  limit: number = 5,
): Array<{
  thread_id: string;
  chat_jid: string;
  snippet: string;
  last_activity: string;
}> {
  if (words.length === 0) return [];

  const likeClauses = words.map(() => 'm.content LIKE ?').join(' OR ');
  const likeParams = words.map((w) => `%${w}%`);

  const rows = db
    .prepare(
      `SELECT s.thread_id, s.chat_jid, m.content, m.timestamp
       FROM (
         SELECT DISTINCT thread_id, chat_jid FROM sessions_v2
         WHERE group_folder = ? AND thread_id IS NOT NULL AND chat_jid IS NOT NULL
         LIMIT 100
       ) s
       JOIN messages m ON m.chat_jid = s.chat_jid
       WHERE m.content != '' AND m.content IS NOT NULL AND (${likeClauses})
       ORDER BY m.timestamp DESC`,
    )
    .all(groupFolder, ...likeParams) as Array<{
    thread_id: string;
    chat_jid: string;
    content: string;
    timestamp: string;
  }>;

  // Deduplicate: keep the most-recent match per thread_id (rows are DESC by timestamp)
  const seen = new Set<string>();
  const results: Array<{
    thread_id: string;
    chat_jid: string;
    snippet: string;
    last_activity: string;
  }> = [];
  for (const row of rows) {
    if (seen.has(row.thread_id)) continue;
    seen.add(row.thread_id);
    results.push({
      thread_id: row.thread_id,
      chat_jid: row.chat_jid,
      snippet: row.content.slice(0, 300),
      last_activity: row.timestamp,
    });
    if (results.length >= limit) break;
  }

  return results;
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

// --- Ship log accessors ---

export function addShipLogEntry(entry: ShipLogEntry): void {
  db.prepare(
    `INSERT OR REPLACE INTO ship_log (id, group_folder, title, description, pr_url, branch, tags, shipped_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.group_folder,
    entry.title,
    entry.description,
    entry.pr_url,
    entry.branch,
    entry.tags,
    entry.shipped_at,
  );
}

export function getShipLog(
  groupFolder: string,
  limit: number = 50,
): ShipLogEntry[] {
  return db
    .prepare(
      `SELECT * FROM ship_log WHERE group_folder = ? ORDER BY shipped_at DESC LIMIT ?`,
    )
    .all(groupFolder, limit) as ShipLogEntry[];
}

// --- Backlog accessors ---

export function addBacklogItem(item: BacklogItem): void {
  db.prepare(
    `INSERT OR REPLACE INTO backlog (id, group_folder, title, description, status, priority, tags, notes, created_at, updated_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.group_folder,
    item.title,
    item.description,
    item.status,
    item.priority,
    item.tags,
    item.notes,
    item.created_at,
    item.updated_at,
    item.resolved_at,
  );
}

export function updateBacklogItem(
  id: string,
  updates: Partial<
    Pick<
      BacklogItem,
      | 'title'
      | 'description'
      | 'status'
      | 'priority'
      | 'tags'
      | 'notes'
      | 'resolved_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.priority !== undefined) {
    fields.push('priority = ?');
    values.push(updates.priority);
  }
  if (updates.tags !== undefined) {
    fields.push('tags = ?');
    values.push(updates.tags);
  }
  if (updates.notes !== undefined) {
    fields.push('notes = ?');
    values.push(updates.notes);
  }
  if (updates.resolved_at !== undefined) {
    fields.push('resolved_at = ?');
    values.push(updates.resolved_at);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE backlog SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteBacklogItem(id: string, groupFolder: string): void {
  db.prepare('DELETE FROM backlog WHERE id = ? AND group_folder = ?').run(
    id,
    groupFolder,
  );
}

const PRIORITY_ORDER = `CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;

export function getBacklog(
  groupFolder: string,
  status?: string,
  limit: number = 100,
): BacklogItem[] {
  if (status) {
    return db
      .prepare(
        `SELECT * FROM backlog WHERE group_folder = ? AND status = ? ORDER BY ${PRIORITY_ORDER}, created_at DESC LIMIT ?`,
      )
      .all(groupFolder, status, limit) as BacklogItem[];
  }
  return db
    .prepare(
      `SELECT * FROM backlog WHERE group_folder = ? ORDER BY
         CASE status WHEN 'in_progress' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,
         ${PRIORITY_ORDER},
         created_at DESC LIMIT ?`,
    )
    .all(groupFolder, limit) as BacklogItem[];
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
