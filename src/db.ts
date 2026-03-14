import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR, TIMEZONE } from './config.js';
import {
  Campaign,
  Contact,
  Conversion,
  ConversionStats,
  Deal,
  DealStageLogEntry,
  NewMessage,
  OutreachLog,
  PipelineHealth,
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
      last_message_time TEXT
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

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      company TEXT,
      title TEXT,
      linkedin_url TEXT,
      phone TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      tags TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
    CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company);
    CREATE INDEX IF NOT EXISTS idx_contacts_source ON contacts(source);

    CREATE TABLE IF NOT EXISTS outreach_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id TEXT NOT NULL,
      campaign_id TEXT,
      type TEXT NOT NULL,
      subject TEXT,
      body TEXT,
      status TEXT NOT NULL DEFAULT 'sent',
      sent_at TEXT NOT NULL,
      response_at TEXT,
      error TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_outreach_contact ON outreach_log(contact_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_campaign ON outreach_log(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach_log(status);

    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      template_subject TEXT,
      template_body TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deals (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'new',
      value_cents INTEGER,
      source TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id)
    );
    CREATE INDEX IF NOT EXISTS idx_deals_group ON deals(group_folder);
    CREATE INDEX IF NOT EXISTS idx_deals_contact ON deals(contact_id);
    CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage);

    CREATE TABLE IF NOT EXISTS deal_stage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id TEXT NOT NULL,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      note TEXT,
      FOREIGN KEY (deal_id) REFERENCES deals(id)
    );
    CREATE INDEX IF NOT EXISTS idx_deal_stage_log ON deal_stage_log(deal_id);

    CREATE TABLE IF NOT EXISTS health_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_group ON usage_log(group_folder);
    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_log(timestamp);

    CREATE TABLE IF NOT EXISTS inbound_message_ids (
      msg_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS conversions (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      channel TEXT NOT NULL,
      customer_id TEXT,
      stage TEXT NOT NULL DEFAULT 'inquiry',
      business TEXT NOT NULL,
      source TEXT,
      value_usd REAL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversions_stage ON conversions(stage);
    CREATE INDEX IF NOT EXISTS idx_conversions_business ON conversions(business);

    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_jid TEXT NOT NULL,
      customer_name TEXT,
      channel TEXT NOT NULL,
      category TEXT NOT NULL,
      matched_patterns TEXT NOT NULL,
      message_snippet TEXT NOT NULL,
      resolution_status TEXT NOT NULL DEFAULT 'open',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(resolution_status);
    CREATE INDEX IF NOT EXISTS idx_complaints_customer ON complaints(customer_jid);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add model/budget override columns for per-task scheduling flexibility
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN model TEXT DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN budget_usd REAL DEFAULT NULL`,
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

  // Add channel_source column to contacts (whatsapp/sms/email)
  try {
    database.exec(`ALTER TABLE contacts ADD COLUMN channel_source TEXT`);
  } catch {
    /* column already exists */
  }

  // Lead generation columns
  try {
    database.exec(
      `ALTER TABLE contacts ADD COLUMN lead_score INTEGER DEFAULT 0`,
    );
  } catch {
    /* exists */
  }
  try {
    database.exec(`ALTER TABLE contacts ADD COLUMN lead_score_reasons TEXT`);
  } catch {
    /* exists */
  }
  try {
    database.exec(`ALTER TABLE contacts ADD COLUMN website TEXT`);
  } catch {
    /* exists */
  }
  try {
    database.exec(`ALTER TABLE contacts ADD COLUMN address TEXT`);
  } catch {
    /* exists */
  }
  try {
    database.exec(`ALTER TABLE contacts ADD COLUMN city TEXT`);
  } catch {
    /* exists */
  }
  try {
    database.exec(`ALTER TABLE contacts ADD COLUMN state TEXT`);
  } catch {
    /* exists */
  }
  try {
    database.exec(`ALTER TABLE contacts ADD COLUMN google_place_id TEXT`);
  } catch {
    /* exists */
  }
  try {
    database.exec(`ALTER TABLE contacts ADD COLUMN industry TEXT`);
  } catch {
    /* exists */
  }

  // Dedup index for Google Maps leads
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_place_id ON contacts(google_place_id) WHERE google_place_id IS NOT NULL`,
  );

  // Add execution_mode column for CLI vs container routing
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN execution_mode TEXT DEFAULT 'cli'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN fallback_to_container INTEGER DEFAULT 1`,
    );
  } catch {
    /* column already exists */
  }

  // Add model column to usage_log for model-specific cost tracking
  try {
    database.exec(`ALTER TABLE usage_log ADD COLUMN model TEXT DEFAULT NULL`);
  } catch {
    /* column already exists */
  }

  // Migrations — add business field to CRM tables for multi-business separation
  const crmMigrations: string[] = [
    `ALTER TABLE contacts ADD COLUMN business TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE complaints ADD COLUMN business TEXT NOT NULL DEFAULT ''`,
  ];
  for (const sql of crmMigrations) {
    try {
      database.exec(sql);
    } catch {
      // Column already exists — ignore
    }
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_contacts_business ON contacts(business);
    CREATE INDEX IF NOT EXISTS idx_complaints_business ON complaints(business);
  `);

  // In-flight spend reservations — survives process crashes
  database.exec(`
    CREATE TABLE IF NOT EXISTS in_flight_spend (
      container_name TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      reserve_usd REAL NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000'); // Wait up to 5s on lock instead of failing immediately
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
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
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
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
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
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

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
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

/**
 * Check if the bot has already replied in a chat after a given timestamp.
 * Used by crash recovery to avoid re-processing messages the bot already handled.
 */
export function hasBotReplyAfter(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): boolean {
  const sql = `
    SELECT COUNT(*) as cnt FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND (is_bot_message = 1 OR content LIKE ?)
    LIMIT 1
  `;
  const row = db
    .prepare(sql)
    .get(chatJid, sinceTimestamp, `${botPrefix}:%`) as { cnt: number };
  return row.cnt > 0;
}

export function getRecentMessages(hours: number, limit: number): NewMessage[] {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
    FROM messages
    WHERE timestamp > ?
    ORDER BY timestamp DESC
    LIMIT ?
  `;
  return db.prepare(sql).all(cutoff, limit) as NewMessage[];
}

/** Get the most recent non-bot sender for a given chat JID. */
/**
 * Check if a message with this ID already exists in the database.
 * Used by Gmail channel to prevent duplicate processing across restarts.
 */
export function messageExists(messageId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM messages WHERE id = ? LIMIT 1")
    .get(messageId);
  return !!row;
}

export function getLastSender(chatJid: string): string | null {
  const row = db
    .prepare(
      `SELECT sender FROM messages
       WHERE chat_jid = ? AND is_bot_message = 0 AND is_from_me = 0
       ORDER BY timestamp DESC LIMIT 1`,
    )
    .get(chatJid) as { sender: string } | undefined;
  return row?.sender || null;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, model, budget_usd, execution_mode, fallback_to_container)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    task.model || null,
    task.budget_usd ?? null,
    task.execution_mode || 'cli',
    task.fallback_to_container ?? 1,
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
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status' | 'model' | 'budget_usd' | 'execution_mode' | 'fallback_to_container'
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
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }
  if (updates.budget_usd !== undefined) {
    fields.push('budget_usd = ?');
    values.push(updates.budget_usd);
  }
  if (updates.execution_mode !== undefined) {
    fields.push('execution_mode = ?');
    values.push(updates.execution_mode);
  }
  if (updates.fallback_to_container !== undefined) {
    fields.push('fallback_to_container = ?');
    values.push(updates.fallback_to_container);
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
      }
    | undefined;
  if (!row) return undefined;
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
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
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
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
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
    };
  }
  return result;
}

// --- CRM accessors ---

export function upsertContact(contact: Contact): void {
  db.prepare(
    `INSERT INTO contacts (id, email, first_name, last_name, company, title, linkedin_url, phone, source, tags, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       company = excluded.company,
       title = excluded.title,
       linkedin_url = COALESCE(excluded.linkedin_url, linkedin_url),
       phone = COALESCE(excluded.phone, phone),
       tags = excluded.tags,
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
  ).run(
    contact.id,
    contact.email,
    contact.first_name,
    contact.last_name,
    contact.company,
    contact.title,
    contact.linkedin_url,
    contact.phone,
    contact.source,
    contact.tags,
    contact.notes,
    contact.created_at,
    contact.updated_at,
  );
}

export function getContact(id: string): Contact | undefined {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as
    | Contact
    | undefined;
}

export function getContactByEmail(email: string): Contact | undefined {
  return db.prepare('SELECT * FROM contacts WHERE email = ?').get(email) as
    | Contact
    | undefined;
}

export function searchContacts(query: string, limit = 50): Contact[] {
  return db
    .prepare(
      `SELECT * FROM contacts
       WHERE first_name LIKE ? OR last_name LIKE ? OR company LIKE ? OR email LIKE ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      `%${query}%`,
      limit,
    ) as Contact[];
}

export function getUncontactedLeads(limit = 10): Contact[] {
  return db
    .prepare(
      `SELECT c.* FROM contacts c
       LEFT JOIN outreach_log o ON c.id = o.contact_id
       WHERE o.id IS NULL
       ORDER BY c.created_at ASC LIMIT ?`,
    )
    .all(limit) as Contact[];
}

export function getLeadsNeedingFollowUp(daysSince = 3, limit = 10): Contact[] {
  const cutoff = new Date(Date.now() - daysSince * 86400000).toISOString();
  return db
    .prepare(
      `SELECT c.* FROM contacts c
       INNER JOIN outreach_log o ON c.id = o.contact_id
       WHERE o.status = 'sent' AND o.sent_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM outreach_log o2
           WHERE o2.contact_id = c.id AND o2.status IN ('replied', 'bounced')
         )
       GROUP BY c.id
       ORDER BY MAX(o.sent_at) ASC LIMIT ?`,
    )
    .all(cutoff, limit) as Contact[];
}

export function logOutreach(log: OutreachLog): void {
  db.prepare(
    `INSERT INTO outreach_log (contact_id, campaign_id, type, subject, body, status, sent_at, response_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    log.contact_id,
    log.campaign_id,
    log.type,
    log.subject,
    log.body,
    log.status,
    log.sent_at,
    log.response_at,
    log.error,
  );
}

export function getOutreachForContact(contactId: string): OutreachLog[] {
  return db
    .prepare(
      'SELECT * FROM outreach_log WHERE contact_id = ? ORDER BY sent_at DESC',
    )
    .all(contactId) as OutreachLog[];
}

export function getOutreachStats(): {
  total_sent: number;
  total_replied: number;
  total_bounced: number;
  sent_today: number;
  sent_this_week: number;
} {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 86400000);

  const total = db
    .prepare(
      `SELECT
         COUNT(*) as total_sent,
         SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) as total_replied,
         SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) as total_bounced
       FROM outreach_log`,
    )
    .get() as {
    total_sent: number;
    total_replied: number;
    total_bounced: number;
  };

  const sentToday = db
    .prepare('SELECT COUNT(*) as count FROM outreach_log WHERE sent_at >= ?')
    .get(today.toISOString()) as { count: number };

  const sentWeek = db
    .prepare('SELECT COUNT(*) as count FROM outreach_log WHERE sent_at >= ?')
    .get(weekAgo.toISOString()) as { count: number };

  return {
    ...total,
    sent_today: sentToday.count,
    sent_this_week: sentWeek.count,
  };
}

export function upsertCampaign(campaign: Campaign): void {
  db.prepare(
    `INSERT INTO campaigns (id, name, description, status, template_subject, template_body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       status = excluded.status,
       template_subject = excluded.template_subject,
       template_body = excluded.template_body,
       updated_at = excluded.updated_at`,
  ).run(
    campaign.id,
    campaign.name,
    campaign.description,
    campaign.status,
    campaign.template_subject,
    campaign.template_body,
    campaign.created_at,
    campaign.updated_at,
  );
}

export function getCampaign(id: string): Campaign | undefined {
  return db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as
    | Campaign
    | undefined;
}

export function getAllCampaigns(): Campaign[] {
  return db
    .prepare('SELECT * FROM campaigns ORDER BY created_at DESC')
    .all() as Campaign[];
}

export function getContactCount(): number {
  return (
    db.prepare('SELECT COUNT(*) as count FROM contacts').get() as {
      count: number;
    }
  ).count;
}

// --- CRM: auto-create contacts from phone numbers ---

/**
 * Create or update a contact from a phone number (e.g., inbound SMS).
 * Uses a placeholder email derived from the phone number to satisfy
 * the UNIQUE constraint without requiring a real email address.
 */
export function upsertContactFromPhone(
  phone: string,
  source: string,
  tags: string[],
): void {
  const now = new Date().toISOString();
  const cleanPhone = phone.replace(/[^+\d]/g, '');
  const placeholderEmail = `${cleanPhone}@sms.nanoclaw`;
  const id = `phone-${cleanPhone}`;

  db.prepare(
    `INSERT INTO contacts (id, email, first_name, last_name, company, title, linkedin_url, phone, source, tags, notes, created_at, updated_at)
     VALUES (?, ?, ?, '', NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       phone = COALESCE(excluded.phone, phone),
       source = excluded.source,
       tags = CASE WHEN excluded.tags IS NOT NULL THEN excluded.tags ELSE tags END,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    placeholderEmail,
    cleanPhone, // first_name = phone number as placeholder
    cleanPhone,
    source,
    tags.length > 0 ? JSON.stringify(tags) : null,
    now,
    now,
  );
}

// --- Deal pipeline accessors ---

export function upsertDeal(deal: Deal): void {
  db.prepare(
    `INSERT INTO deals (id, contact_id, group_folder, stage, value_cents, source, notes, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       stage = excluded.stage,
       value_cents = COALESCE(excluded.value_cents, value_cents),
       source = COALESCE(excluded.source, source),
       notes = excluded.notes,
       updated_at = excluded.updated_at,
       closed_at = excluded.closed_at`,
  ).run(
    deal.id,
    deal.contact_id,
    deal.group_folder,
    deal.stage,
    deal.value_cents,
    deal.source,
    deal.notes,
    deal.created_at,
    deal.updated_at,
    deal.closed_at,
  );
}

export function getDeal(id: string): Deal | undefined {
  return db.prepare('SELECT * FROM deals WHERE id = ?').get(id) as
    | Deal
    | undefined;
}

export function getDealByContact(contactId: string): Deal | undefined {
  return db
    .prepare(
      'SELECT * FROM deals WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(contactId) as Deal | undefined;
}

export function getDealsByGroup(groupFolder: string, stage?: string): Deal[] {
  if (stage) {
    return db
      .prepare(
        'SELECT * FROM deals WHERE group_folder = ? AND stage = ? ORDER BY updated_at DESC',
      )
      .all(groupFolder, stage) as Deal[];
  }
  return db
    .prepare(
      'SELECT * FROM deals WHERE group_folder = ? ORDER BY updated_at DESC',
    )
    .all(groupFolder) as Deal[];
}

export function moveDealStage(
  dealId: string,
  toStage: string,
  note?: string,
): void {
  const deal = getDeal(dealId);
  if (!deal) throw new Error(`Deal ${dealId} not found`);

  const now = new Date().toISOString();
  const closedAt =
    toStage === 'closed_won' || toStage === 'closed_lost'
      ? now
      : deal.closed_at;

  const move = db.transaction(() => {
    db.prepare(
      `UPDATE deals SET stage = ?, updated_at = ?, closed_at = ? WHERE id = ?`,
    ).run(toStage, now, closedAt, dealId);

    db.prepare(
      `INSERT INTO deal_stage_log (deal_id, from_stage, to_stage, changed_at, note)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(dealId, deal.stage, toStage, now, note || null);
  });
  move();
}

export function getDealStageHistory(dealId: string): DealStageLogEntry[] {
  return db
    .prepare(
      'SELECT * FROM deal_stage_log WHERE deal_id = ? ORDER BY changed_at ASC',
    )
    .all(dealId) as DealStageLogEntry[];
}

export function getPipelineHealth(groupFolder: string): PipelineHealth {
  const stages = db
    .prepare(
      `SELECT stage, COUNT(*) as count FROM deals WHERE group_folder = ? GROUP BY stage`,
    )
    .all(groupFolder) as Array<{ stage: string; count: number }>;

  const totals = db
    .prepare(
      `SELECT COUNT(*) as total, COALESCE(SUM(value_cents), 0) as total_value
     FROM deals WHERE group_folder = ?`,
    )
    .get(groupFolder) as { total: number; total_value: number };

  const stageMap: Record<string, number> = {};
  for (const s of stages) stageMap[s.stage] = s.count;

  return {
    group_folder: groupFolder,
    stages: stageMap,
    total: totals.total,
    total_value_cents: totals.total_value,
  };
}

// --- Health state accessors ---

export function getHealthState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM health_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setHealthState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO health_state (key, value, updated_at) VALUES (?, ?, ?)',
  ).run(key, value, new Date().toISOString());
}

export function getLastMessageTimestamp(): string | null {
  const row = db
    .prepare(
      'SELECT MAX(timestamp) as ts FROM messages WHERE is_bot_message = 0',
    )
    .get() as { ts: string | null } | undefined;
  return row?.ts || null;
}

// --- Usage log accessors ---

export interface UsageEntry {
  group_folder: string;
  model?: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  timestamp: string;
}

export function logUsage(entry: UsageEntry): void {
  db.prepare(
    `INSERT INTO usage_log (group_folder, model, input_tokens, output_tokens, cache_read_tokens, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.group_folder,
    entry.model || null,
    entry.input_tokens,
    entry.output_tokens,
    entry.cache_read_tokens,
    entry.timestamp,
  );
}

// Model pricing per million tokens: [input, output, cache_read]
const MODEL_PRICING: Record<string, [number, number, number]> = {
  'claude-sonnet-4-6':    [3.00, 15.00, 0.30],
  'claude-sonnet-4-5':    [3.00, 15.00, 0.30],
  'claude-haiku-4-5':     [0.80,  4.00, 0.08],
  'claude-opus-4-6':      [15.00, 75.00, 1.50],
};
const DEFAULT_PRICING: [number, number, number] = [3.00, 15.00, 0.30]; // Sonnet as fallback

/**
 * Get estimated daily spend in USD based on token usage.
 * Uses model-specific pricing when available, falls back to Sonnet rates.
 * Calculates "today" using the configured TIMEZONE, not UTC.
 */
export function getDailySpendUsd(): number {
  // Calculate midnight in the configured timezone, then convert to UTC for SQL.
  // We get today's date in the target timezone, then find midnight of that date
  // in UTC by constructing an ISO string and parsing it with timezone offset.
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value || '0';
  // Get today's date in the target timezone (e.g. "2026-03-12")
  const todayLocal = `${get('year')}-${get('month')}-${get('day')}`;
  // Find the UTC timestamp of midnight in the target timezone by creating a date
  // at midnight local time and checking the offset. We do this by finding two
  // probe points and using the one that lands on the correct local date.
  const midnightGuess = new Date(`${todayLocal}T00:00:00Z`);
  // Adjust: find how many ms the timezone is offset from UTC on this date
  const localAtGuess = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(midnightGuess);
  const guessGet = (t: string) => localAtGuess.find(p => p.type === t)?.value || '0';
  const guessDate = `${guessGet('year')}-${guessGet('month')}-${guessGet('day')}`;
  const guessHour = parseInt(guessGet('hour'), 10);
  const guessMinute = parseInt(guessGet('minute'), 10);
  // If guessDate matches todayLocal, the offset from midnight is guessHour:guessMinute
  // If not, we need to adjust by +/- 24h
  let offsetMs: number;
  if (guessDate === todayLocal) {
    offsetMs = (guessHour * 60 + guessMinute) * 60000;
  } else if (guessDate < todayLocal) {
    offsetMs = -((24 - guessHour) * 60 - guessMinute) * 60000;
  } else {
    offsetMs = ((24 + guessHour) * 60 + guessMinute) * 60000;
  }
  const todayStartUtc = new Date(midnightGuess.getTime() - offsetMs).toISOString();

  const rows = db
    .prepare(
      `SELECT model, input_tokens as inp, output_tokens as out, cache_read_tokens as cache
       FROM usage_log WHERE timestamp >= ?`,
    )
    .all(todayStartUtc) as { model: string | null; inp: number; out: number; cache: number }[];

  let totalUsd = 0;
  for (const row of rows) {
    const [inpRate, outRate, cacheRate] = MODEL_PRICING[row.model || ''] || DEFAULT_PRICING;
    totalUsd += (row.inp * inpRate + row.out * outRate + row.cache * cacheRate) / 1_000_000;
  }
  return totalUsd;
}

/** Reserve in-flight spend for a container (persisted to survive crashes). */
export function addInFlightSpend(containerName: string, groupFolder: string, reserveUsd: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO in_flight_spend (container_name, group_folder, reserve_usd, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(containerName, groupFolder, reserveUsd, new Date().toISOString());
}

/** Release in-flight spend reservation when a container completes. */
export function removeInFlightSpend(containerName: string): void {
  db.prepare(`DELETE FROM in_flight_spend WHERE container_name = ?`).run(containerName);
}

/** Sum all in-flight spend reservations (used on startup and for budget checks). */
export function getInFlightSpendUsd(): number {
  const row = db.prepare(`SELECT COALESCE(SUM(reserve_usd), 0) as total FROM in_flight_spend`).get() as { total: number };
  return row.total;
}

export function getUsageStats(
  groupFolder?: string,
  sinceDays = 30,
): {
  total_input: number;
  total_output: number;
  total_cache_read: number;
  count: number;
} {
  const cutoff = new Date(Date.now() - sinceDays * 86400000).toISOString();

  if (groupFolder) {
    return db
      .prepare(
        `SELECT
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COUNT(*) as count
       FROM usage_log WHERE group_folder = ? AND timestamp >= ?`,
      )
      .get(groupFolder, cutoff) as {
      total_input: number;
      total_output: number;
      total_cache_read: number;
      count: number;
    };
  }

  return db
    .prepare(
      `SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
      COUNT(*) as count
     FROM usage_log WHERE timestamp >= ?`,
    )
    .get(cutoff) as {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    count: number;
  };
}

// --- Maintenance / Pruning ---

/**
 * Prune old log entries to prevent unbounded database growth.
 * Called periodically from the health monitor.
 */
// --- Inbound message dedup (persistent) ---

export function hasMessageId(msgId: string): boolean {
  const row = db.prepare('SELECT 1 FROM inbound_message_ids WHERE msg_id = ?').get(msgId);
  return row !== undefined;
}

export function recordMessageId(msgId: string): void {
  db.prepare('INSERT OR IGNORE INTO inbound_message_ids (msg_id) VALUES (?)').run(msgId);
}

export function pruneOldMessageIds(olderThanMs = 86_400_000): number {
  const cutoffEpoch = Math.floor((Date.now() - olderThanMs) / 1000);
  return db.prepare('DELETE FROM inbound_message_ids WHERE created_at < ?').run(cutoffEpoch).changes;
}

export function pruneOldLogs(): { taskRuns: number; usage: number; messages: number } {
  const taskRunCutoff = new Date(Date.now() - 30 * 86400000).toISOString(); // 30 days
  const usageCutoff = new Date(Date.now() - 90 * 86400000).toISOString(); // 90 days
  const messageCutoff = new Date(Date.now() - 180 * 86400000).toISOString(); // 180 days

  const taskRuns = db.prepare('DELETE FROM task_run_logs WHERE run_at < ?').run(taskRunCutoff).changes;
  const usage = db.prepare('DELETE FROM usage_log WHERE timestamp < ?').run(usageCutoff).changes;
  const messages = db.prepare('DELETE FROM messages WHERE timestamp < ?').run(messageCutoff).changes;

  return { taskRuns, usage, messages };
}

// --- Conversion tracking accessors ---

export function createConversion(data: Omit<Conversion, 'updated_at'> & { updated_at?: string }): void {
  const now = data.updated_at || new Date().toISOString();
  db.prepare(
    `INSERT INTO conversions (id, chat_jid, channel, customer_id, stage, business, source, value_usd, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.id,
    data.chat_jid,
    data.channel,
    data.customer_id || null,
    data.stage,
    data.business,
    data.source || null,
    data.value_usd ?? null,
    data.notes || null,
    data.created_at,
    now,
  );
}

export function updateConversionStage(id: string, stage: string, notes?: string): void {
  const now = new Date().toISOString();
  if (notes) {
    db.prepare(
      `UPDATE conversions SET stage = ?, notes = ?, updated_at = ? WHERE id = ?`,
    ).run(stage, notes, now, id);
  } else {
    db.prepare(
      `UPDATE conversions SET stage = ?, updated_at = ? WHERE id = ?`,
    ).run(stage, now, id);
  }
}

export function getConversionsByBusiness(business: string): Conversion[] {
  return db
    .prepare('SELECT * FROM conversions WHERE business = ? ORDER BY updated_at DESC')
    .all(business) as Conversion[];
}

export function getConversionStats(business?: string, days?: number): ConversionStats {
  const cutoff = days
    ? new Date(Date.now() - days * 86400000).toISOString()
    : '1970-01-01T00:00:00.000Z';

  const baseWhere = business
    ? 'WHERE business = ? AND created_at >= ?'
    : 'WHERE created_at >= ?';
  const params: unknown[] = business ? [business, cutoff] : [cutoff];

  const stages = db
    .prepare(`SELECT stage, COUNT(*) as count FROM conversions ${baseWhere} GROUP BY stage`)
    .all(...params) as Array<{ stage: string; count: number }>;

  const totals = db
    .prepare(
      `SELECT COUNT(*) as total, COALESCE(SUM(value_usd), 0) as total_value FROM conversions ${baseWhere}`,
    )
    .get(...params) as { total: number; total_value: number };

  const completed = db
    .prepare(
      `SELECT COUNT(*) as count FROM conversions ${baseWhere} AND stage IN ('booked', 'completed', 'reviewed')`,
    )
    .get(...params) as { count: number };

  const byStage: Record<string, number> = {};
  for (const s of stages) byStage[s.stage] = s.count;

  return {
    total: totals.total,
    byStage,
    totalValue: totals.total_value,
    conversionRate: totals.total > 0 ? completed.count / totals.total : 0,
  };
}

export function getStaleConversions(staleDays: number): Conversion[] {
  const cutoff = new Date(Date.now() - staleDays * 86400000).toISOString();
  return db
    .prepare(
      `SELECT * FROM conversions
       WHERE stage IN ('inquiry', 'quoted') AND updated_at < ?
       ORDER BY updated_at ASC`,
    )
    .all(cutoff) as Conversion[];
}

// --- Complaint tracking accessors ---

export interface ComplaintRow {
  id: number;
  customer_jid: string;
  customer_name: string | null;
  channel: string;
  category: string;
  matched_patterns: string;
  message_snippet: string;
  resolution_status: string;
  notes: string | null;
  created_at: string;
  resolved_at: string | null;
}

export function createComplaint(data: {
  customerJid: string;
  customerName?: string;
  channel: string;
  category: string;
  matchedPatterns: string[];
  messageSnippet: string;
}): number {
  const result = db.prepare(
    `INSERT INTO complaints (customer_jid, customer_name, channel, category, matched_patterns, message_snippet)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    data.customerJid,
    data.customerName || null,
    data.channel,
    data.category,
    JSON.stringify(data.matchedPatterns),
    data.messageSnippet,
  );
  return Number(result.lastInsertRowid);
}

export function updateComplaintStatus(
  id: number,
  status: 'open' | 'investigating' | 'refunded' | 'resolved',
  notes?: string,
): void {
  const now = new Date().toISOString();
  const resolvedAt = status === 'resolved' || status === 'refunded' ? now : null;
  if (notes) {
    db.prepare(
      `UPDATE complaints SET resolution_status = ?, notes = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?`,
    ).run(status, notes, resolvedAt, id);
  } else {
    db.prepare(
      `UPDATE complaints SET resolution_status = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?`,
    ).run(status, resolvedAt, id);
  }
}

function mapComplaintRow(row: ComplaintRow) {
  return {
    id: row.id,
    customerJid: row.customer_jid,
    customerName: row.customer_name,
    channel: row.channel,
    category: row.category,
    matchedPatterns: row.matched_patterns,
    messageSnippet: row.message_snippet,
    resolutionStatus: row.resolution_status,
    notes: row.notes,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function getOpenComplaints() {
  const rows = db
    .prepare(
      `SELECT * FROM complaints WHERE resolution_status = 'open' ORDER BY created_at DESC`,
    )
    .all() as ComplaintRow[];
  return rows.map(mapComplaintRow);
}

export function getComplaintsByCustomer(jid: string) {
  const rows = db
    .prepare(
      `SELECT * FROM complaints WHERE customer_jid = ? ORDER BY created_at DESC`,
    )
    .all(jid) as ComplaintRow[];
  return rows.map(mapComplaintRow);
}

export function getComplaintStats(days?: number): {
  total: number;
  open: number;
  resolved: number;
  avgResolutionHours: number | null;
} {
  const cutoff = days
    ? new Date(Date.now() - days * 86400000).toISOString()
    : '1970-01-01T00:00:00.000Z';

  const counts = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN resolution_status = 'open' THEN 1 ELSE 0 END) as open,
         SUM(CASE WHEN resolution_status IN ('resolved', 'refunded') THEN 1 ELSE 0 END) as resolved
       FROM complaints WHERE created_at >= ?`,
    )
    .get(cutoff) as { total: number; open: number; resolved: number };

  const avgRow = db
    .prepare(
      `SELECT AVG(
         (julianday(resolved_at) - julianday(created_at)) * 24
       ) as avg_hours
       FROM complaints
       WHERE resolved_at IS NOT NULL AND created_at >= ?`,
    )
    .get(cutoff) as { avg_hours: number | null };

  return {
    total: counts.total,
    open: counts.open,
    resolved: counts.resolved,
    avgResolutionHours: avgRow.avg_hours !== null ? Math.round(avgRow.avg_hours * 10) / 10 : null,
  };
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
      setRegisteredGroup(jid, group);
    }
  }
}
