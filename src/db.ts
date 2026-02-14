import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR } from './config.js';
import { Agent, ChannelRoute, HeartbeatConfig, NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog, registeredGroupToAgent, registeredGroupToRoute } from './types.js';

let db: Database;

function createSchema(database: Database): void {
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
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

  // Add heartbeat column to registered_groups (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN heartbeat TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add discord_guild_id and server_folder columns to registered_groups
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN discord_guild_id TEXT`);
  } catch { /* column already exists */ }
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN server_folder TEXT`);
  } catch { /* column already exists */ }

  // Add discord_guild_id column to chats table
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN discord_guild_id TEXT`);
  } catch { /* column already exists */ }

  // Add created_at column to sessions table
  // Note: SQLite ALTER TABLE requires constant defaults, so we use a fixed epoch.
  // New sessions get datetime('now') via INSERT in setSession().
  try {
    database.exec(`ALTER TABLE sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'`);
  } catch { /* column already exists */ }

  // Add backend and description columns to registered_groups (sprites backend support)
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN backend TEXT`);
  } catch { /* column already exists */ }
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN description TEXT`);
  } catch { /* column already exists */ }

  // Add auto-respond columns to registered_groups
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN auto_respond_to_questions INTEGER DEFAULT 0`);
  } catch { /* column already exists */ }
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN auto_respond_keywords TEXT`);
  } catch { /* column already exists */ }

  // --- Agent-Channel Decoupling tables ---
  database.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      folder TEXT NOT NULL UNIQUE,
      backend TEXT NOT NULL DEFAULT 'apple-container',
      container_config TEXT,
      heartbeat TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      is_local INTEGER NOT NULL DEFAULT 1,
      server_folder TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_routes (
      channel_jid TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      trigger_pattern TEXT NOT NULL,
      requires_trigger INTEGER NOT NULL DEFAULT 1,
      discord_guild_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_channel_routes_agent ON channel_routes(agent_id);
  `);

  // Auto-migrate from registered_groups → agents + channel_routes
  migrateRegisteredGroupsToAgents(database);
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
  discordGuildId?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.query(
      `
      INSERT INTO chats (jid, name, last_message_time, discord_guild_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        discord_guild_id = COALESCE(excluded.discord_guild_id, discord_guild_id)
    `,
    ).run(chatJid, name, timestamp, discordGuildId || null);
  } else {
    // Update timestamp only, preserve existing name if any
    db.query(
      `
      INSERT INTO chats (jid, name, last_message_time, discord_guild_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        discord_guild_id = COALESCE(excluded.discord_guild_id, discord_guild_id)
    `,
    ).run(chatJid, chatJid, timestamp, discordGuildId || null);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.query(
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
 * Get the Discord guild ID for a chat JID from stored metadata.
 */
export function getChatGuildId(chatJid: string): string | undefined {
  const row = db
    .prepare('SELECT discord_guild_id FROM chats WHERE jid = ?')
    .get(chatJid) as { discord_guild_id: string | null } | undefined;
  return row?.discord_guild_id || undefined;
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
  db.query(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.query(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
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
}): void {
  db.query(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter out bot's own messages by checking content prefix (not is_from_me, since user shares the account)
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders}) AND content NOT LIKE ?
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
  // Filter out bot's own messages by checking content prefix
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.query(
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
  return db.query('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
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
  // SECURITY NOTE: Field names are hardcoded below (not user-controlled), making this safe from SQL injection.
  // All values use parameterized queries (?). If this logic changes to allow dynamic field selection,
  // ensure field names are validated against an allowlist.
  const fields: string[] = [];
  const values: (string | null)[] = [];

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
  db.query(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  // Wrap in transaction to ensure both deletes succeed or both roll back
  const transaction = db.transaction(() => {
    db.query('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
    db.query('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  });

  transaction();
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

/** Advance next_run without touching last_run/last_result (used before enqueue). */
export function advanceTaskNextRun(id: string, nextRun: string | null): void {
  db.query(
    `UPDATE scheduled_tasks SET next_run = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END WHERE id = ?`,
  ).run(nextRun, nextRun, id);
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.query(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.query(
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
  db.query(
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
  // Only update created_at when the session ID actually changes (new session)
  const existing = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;

  if (existing && existing.session_id === sessionId) {
    return; // Same session, no update needed
  }

  db.query(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id, created_at) VALUES (?, ?, datetime(\'now\'))',
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

/**
 * Expire sessions older than maxAgeMs. Returns the folders that were expired.
 */
export function expireStaleSessions(maxAgeMs: number): string[] {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stale = db
    .prepare('SELECT group_folder FROM sessions WHERE created_at < ?')
    .all(cutoff) as Array<{ group_folder: string }>;
  if (stale.length > 0) {
    db.query('DELETE FROM sessions WHERE created_at < ?').run(cutoff);
  }
  return stale.map((r) => r.group_folder);
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
        heartbeat: string | null;
        discord_guild_id: string | null;
        server_folder: string | null;
        backend: string | null;
        description: string | null;
        auto_respond_to_questions: number | null;
        auto_respond_keywords: string | null;
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
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    heartbeat: row.heartbeat
      ? (JSON.parse(row.heartbeat) as HeartbeatConfig)
      : undefined,
    discordGuildId: row.discord_guild_id || undefined,
    serverFolder: row.server_folder || undefined,
    backend: (row.backend as any) || undefined,
    description: row.description || undefined,
    autoRespondToQuestions: row.auto_respond_to_questions === 1 || undefined,
    autoRespondKeywords: row.auto_respond_keywords ? JSON.parse(row.auto_respond_keywords) : undefined,
  };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  db.query(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, heartbeat, discord_guild_id, server_folder, backend, description, auto_respond_to_questions, auto_respond_keywords)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.heartbeat ? JSON.stringify(group.heartbeat) : null,
    group.discordGuildId || null,
    group.serverFolder || null,
    group.backend || null,
    group.description || null,
    group.autoRespondToQuestions ? 1 : 0,
    group.autoRespondKeywords ? JSON.stringify(group.autoRespondKeywords) : null,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    heartbeat: string | null;
    discord_guild_id: string | null;
    server_folder: string | null;
    backend: string | null;
    description: string | null;
    auto_respond_to_questions: number | null;
    auto_respond_keywords: string | null;
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
      requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      heartbeat: row.heartbeat
        ? (JSON.parse(row.heartbeat) as HeartbeatConfig)
        : undefined,
      discordGuildId: row.discord_guild_id || undefined,
      serverFolder: row.server_folder || undefined,
      backend: (row.backend as any) || undefined,
      description: row.description || undefined,
      autoRespondToQuestions: row.auto_respond_to_questions === 1 || undefined,
      autoRespondKeywords: row.auto_respond_keywords ? JSON.parse(row.auto_respond_keywords) : undefined,
    };
  }
  return result;
}

// --- Agent + ChannelRoute CRUD ---

function migrateRegisteredGroupsToAgents(database: Database): void {
  // Check if migration already happened (agents table has data)
  const agentCount = database.prepare('SELECT COUNT(*) as cnt FROM agents').get() as { cnt: number };
  if (agentCount.cnt > 0) return;

  // Read all registered_groups
  const rows = database.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    heartbeat: string | null;
    discord_guild_id: string | null;
    server_folder: string | null;
    backend: string | null;
    description: string | null;
  }>;

  if (rows.length === 0) return;

  // Group rows by folder to deduplicate (multiple JIDs can map to same folder)
  const agentsByFolder = new Map<string, typeof rows[0]>();
  for (const row of rows) {
    if (!agentsByFolder.has(row.folder)) {
      agentsByFolder.set(row.folder, row);
    }
  }

  const insertAgent = database.prepare(`
    INSERT OR IGNORE INTO agents (id, name, description, folder, backend, container_config, heartbeat, is_admin, is_local, server_folder, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertRoute = database.prepare(`
    INSERT OR IGNORE INTO channel_routes (channel_jid, agent_id, trigger_pattern, requires_trigger, discord_guild_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const [folder, row] of agentsByFolder) {
    const isMain = folder === 'main';
    const backend = row.backend || 'apple-container';
    const isLocal = backend === 'apple-container' || backend === 'docker';

    insertAgent.run(
      folder,              // id
      row.name,
      row.description,
      folder,
      backend,
      row.container_config,
      row.heartbeat,
      isMain ? 1 : 0,     // is_admin
      isLocal ? 1 : 0,    // is_local
      row.server_folder,
      row.added_at,
    );
  }

  // Insert all routes (including multiple JIDs per agent)
  for (const row of rows) {
    insertRoute.run(
      row.jid,
      row.folder,          // agent_id = folder
      row.trigger_pattern,
      row.requires_trigger === null ? 1 : row.requires_trigger,
      row.discord_guild_id,
      row.added_at,
    );
  }
}

export function getAgent(id: string): Agent | undefined {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as {
    id: string;
    name: string;
    description: string | null;
    folder: string;
    backend: string;
    container_config: string | null;
    heartbeat: string | null;
    is_admin: number;
    is_local: number;
    server_folder: string | null;
    created_at: string;
  } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    folder: row.folder,
    backend: row.backend as Agent['backend'],
    containerConfig: row.container_config ? JSON.parse(row.container_config) : undefined,
    heartbeat: row.heartbeat ? JSON.parse(row.heartbeat) as HeartbeatConfig : undefined,
    isAdmin: row.is_admin === 1,
    isLocal: row.is_local === 1,
    serverFolder: row.server_folder || undefined,
    createdAt: row.created_at,
  };
}

export function getAllAgents(): Record<string, Agent> {
  const rows = db.prepare('SELECT * FROM agents').all() as Array<{
    id: string;
    name: string;
    description: string | null;
    folder: string;
    backend: string;
    container_config: string | null;
    heartbeat: string | null;
    is_admin: number;
    is_local: number;
    server_folder: string | null;
    created_at: string;
  }>;
  const result: Record<string, Agent> = {};
  for (const row of rows) {
    result[row.id] = {
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      folder: row.folder,
      backend: row.backend as Agent['backend'],
      containerConfig: row.container_config ? JSON.parse(row.container_config) : undefined,
      heartbeat: row.heartbeat ? JSON.parse(row.heartbeat) as HeartbeatConfig : undefined,
      isAdmin: row.is_admin === 1,
      isLocal: row.is_local === 1,
      serverFolder: row.server_folder || undefined,
      createdAt: row.created_at,
    };
  }
  return result;
}

export function setAgent(agent: Agent): void {
  db.query(`
    INSERT OR REPLACE INTO agents (id, name, description, folder, backend, container_config, heartbeat, is_admin, is_local, server_folder, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id,
    agent.name,
    agent.description || null,
    agent.folder,
    agent.backend,
    agent.containerConfig ? JSON.stringify(agent.containerConfig) : null,
    agent.heartbeat ? JSON.stringify(agent.heartbeat) : null,
    agent.isAdmin ? 1 : 0,
    agent.isLocal ? 1 : 0,
    agent.serverFolder || null,
    agent.createdAt,
  );
}

export function getChannelRoute(channelJid: string): ChannelRoute | undefined {
  const row = db.prepare('SELECT * FROM channel_routes WHERE channel_jid = ?').get(channelJid) as {
    channel_jid: string;
    agent_id: string;
    trigger_pattern: string;
    requires_trigger: number;
    discord_guild_id: string | null;
    created_at: string;
  } | undefined;
  if (!row) return undefined;
  return {
    channelJid: row.channel_jid,
    agentId: row.agent_id,
    trigger: row.trigger_pattern,
    requiresTrigger: row.requires_trigger === 1,
    discordGuildId: row.discord_guild_id || undefined,
    createdAt: row.created_at,
  };
}

export function getAllChannelRoutes(): Record<string, ChannelRoute> {
  const rows = db.prepare('SELECT * FROM channel_routes').all() as Array<{
    channel_jid: string;
    agent_id: string;
    trigger_pattern: string;
    requires_trigger: number;
    discord_guild_id: string | null;
    created_at: string;
  }>;
  const result: Record<string, ChannelRoute> = {};
  for (const row of rows) {
    result[row.channel_jid] = {
      channelJid: row.channel_jid,
      agentId: row.agent_id,
      trigger: row.trigger_pattern,
      requiresTrigger: row.requires_trigger === 1,
      discordGuildId: row.discord_guild_id || undefined,
      createdAt: row.created_at,
    };
  }
  return result;
}

export function setChannelRoute(route: ChannelRoute): void {
  db.query(`
    INSERT OR REPLACE INTO channel_routes (channel_jid, agent_id, trigger_pattern, requires_trigger, discord_guild_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    route.channelJid,
    route.agentId,
    route.trigger,
    route.requiresTrigger ? 1 : 0,
    route.discordGuildId || null,
    route.createdAt,
  );
}

export function getRoutesForAgent(agentId: string): ChannelRoute[] {
  const rows = db.prepare('SELECT * FROM channel_routes WHERE agent_id = ?').all(agentId) as Array<{
    channel_jid: string;
    agent_id: string;
    trigger_pattern: string;
    requires_trigger: number;
    discord_guild_id: string | null;
    created_at: string;
  }>;
  return rows.map((row) => ({
    channelJid: row.channel_jid,
    agentId: row.agent_id,
    trigger: row.trigger_pattern,
    requiresTrigger: row.requires_trigger === 1,
    discordGuildId: row.discord_guild_id || undefined,
    createdAt: row.created_at,
  }));
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
