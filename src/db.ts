import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { LiveTrade, MarketWatcher, NewMessage, OptimizationResult, PaperTrade, RegisteredGroup, ScheduledTask, TaskRunLog, TradingPreset, TradingRun, User } from './types.js';

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
    database.prepare(
      `UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`,
    ).run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add users table if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TEXT NOT NULL
      )
    `);
  } catch {
    /* table already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE chats ADD COLUMN channel TEXT`,
    );
    database.exec(
      `ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`,
    );
    // Backfill from JID patterns
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`);
    database.exec(`UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`);
    database.exec(`UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`);
    database.exec(`UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`);
    database.exec(`UPDATE chats SET channel = 'imessage', is_group = 0 WHERE jid LIKE 'imsg:%' AND jid NOT LIKE 'imsg-group:%'`);
    database.exec(`UPDATE chats SET channel = 'imessage', is_group = 1 WHERE jid LIKE 'imsg-group:%'`);
  } catch {
    /* columns already exist */
  }

  // Trading tables
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS trading_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        platform TEXT NOT NULL,
        entry_price REAL NOT NULL,
        size REAL NOT NULL,
        entry_date TEXT NOT NULL,
        exit_date TEXT,
        exit_price REAL,
        status TEXT NOT NULL DEFAULT 'open',
        pnl REAL,
        strategy TEXT NOT NULL,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS trading_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position_id INTEGER,
        platform TEXT NOT NULL,
        symbol TEXT NOT NULL,
        order_type TEXT NOT NULL,
        size REAL NOT NULL,
        limit_price REAL,
        status TEXT NOT NULL DEFAULT 'pending',
        timestamp TEXT NOT NULL,
        filled_at TEXT,
        error_message TEXT,
        FOREIGN KEY (position_id) REFERENCES trading_positions(id)
      );

      CREATE TABLE IF NOT EXISTS market_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        price REAL NOT NULL,
        volume REAL,
        open_interest REAL,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS strategy_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        current_bias TEXT,
        rsi_2day REAL,
        rsi_14day REAL,
        volatility REAL,
        confidence REAL,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS performance_metrics (
        date TEXT PRIMARY KEY,
        total_pnl REAL NOT NULL,
        win_rate REAL NOT NULL,
        total_trades INTEGER NOT NULL,
        winning_trades INTEGER NOT NULL,
        max_drawdown REAL NOT NULL,
        sharpe_ratio REAL,
        avg_win REAL,
        avg_loss REAL,
        largest_win REAL,
        largest_loss REAL,
        consecutive_losses INTEGER
      );

      CREATE TABLE IF NOT EXISTS backtest_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        strategy TEXT NOT NULL,
        total_trades INTEGER NOT NULL,
        win_rate REAL NOT NULL,
        total_pnl REAL NOT NULL,
        max_drawdown REAL NOT NULL,
        sharpe_ratio REAL,
        notes TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_trading_positions_status ON trading_positions(status);
      CREATE INDEX IF NOT EXISTS idx_trading_positions_symbol ON trading_positions(symbol);
      CREATE INDEX IF NOT EXISTS idx_trading_orders_status ON trading_orders(status);
      CREATE INDEX IF NOT EXISTS idx_market_data_symbol ON market_data(platform, symbol, timestamp);
      CREATE INDEX IF NOT EXISTS idx_strategy_state_timestamp ON strategy_state(timestamp);
    `);
  } catch {
    /* tables already exist */
  }

  // Trading management tables
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS trading_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        strategy TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'paper',
        initial_capital REAL DEFAULT 10000,
        risk_params TEXT NOT NULL,
        schedule_type TEXT,
        schedule_value TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trading_runs (
        id TEXT PRIMARY KEY,
        preset_id TEXT,
        task_id TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        platform TEXT NOT NULL,
        strategy TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'paper',
        initial_capital REAL DEFAULT 10000,
        risk_params TEXT NOT NULL,
        start_date TEXT,
        end_date TEXT,
        results TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_trading_runs_type ON trading_runs(type);
      CREATE INDEX IF NOT EXISTS idx_trading_runs_status ON trading_runs(status);

      CREATE TABLE IF NOT EXISTS account_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  } catch {
    /* tables already exist */
  }

  // Market watchers + optimization tables
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS market_watchers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_ids TEXT NOT NULL,
        market_slugs TEXT,
        interval_ms INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        data_points INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_market_watchers_status ON market_watchers(status);

      CREATE TABLE IF NOT EXISTS optimization_results (
        id TEXT PRIMARY KEY,
        watcher_id TEXT NOT NULL,
        strategy TEXT NOT NULL,
        param_ranges TEXT NOT NULL,
        results TEXT NOT NULL,
        optimize_for TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_optimization_results_watcher ON optimization_results(watcher_id);
    `);
  } catch {
    /* tables already exist */
  }

  // Paper trades table
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS paper_trades (
        id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        market_title TEXT,
        side TEXT NOT NULL,
        action TEXT NOT NULL,
        qty INTEGER NOT NULL,
        entry_price INTEGER NOT NULL,
        exit_price INTEGER,
        status TEXT NOT NULL DEFAULT 'open',
        strategy TEXT NOT NULL DEFAULT 'uncategorized',
        market_type TEXT,
        event_ticker TEXT,
        close_time TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        settled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status);
    `);
  } catch {
    /* table already exists */
  }

  // Add last_snapshot_at column to trading_runs (for strategy auto-resume)
  try {
    database.exec(`ALTER TABLE trading_runs ADD COLUMN last_snapshot_at TEXT`);
  } catch {
    /* column already exists */
  }

  // Add strategy column to paper_trades if it doesn't exist (migration)
  try {
    database.exec(`ALTER TABLE paper_trades ADD COLUMN strategy TEXT NOT NULL DEFAULT 'uncategorized'`);
    // Backfill seeded trades with their strategies
    database.exec(`UPDATE paper_trades SET strategy = 'center_bracket' WHERE id = 'pt-seed-trade1'`);
    database.exec(`UPDATE paper_trades SET strategy = 'spread' WHERE id IN ('pt-seed-trade2a','pt-seed-trade2b','pt-seed-trade2c')`);
    database.exec(`UPDATE paper_trades SET strategy = 'directional' WHERE id = 'pt-seed-trade5'`);
    database.exec(`UPDATE paper_trades SET strategy = 'lottery' WHERE id = 'pt-seed-trade6'`);
    database.exec(`UPDATE paper_trades SET strategy = 'momentum_15m' WHERE id = 'pt-seed-trade7'`);
  } catch {
    /* column already exists */
  }

  // Add run_id column to paper_trades if it doesn't exist (migration)
  try {
    database.exec(`ALTER TABLE paper_trades ADD COLUMN run_id TEXT`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_paper_trades_run_id ON paper_trades(run_id)`);
  } catch {
    /* column already exists */
  }

  // Live trades table
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS live_trades (
        id TEXT PRIMARY KEY,
        kalshi_order_id TEXT,
        ticker TEXT NOT NULL,
        market_title TEXT,
        side TEXT NOT NULL,
        action TEXT NOT NULL,
        qty INTEGER NOT NULL,
        entry_price INTEGER NOT NULL,
        fill_price INTEGER,
        exit_price INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        strategy TEXT NOT NULL,
        run_id TEXT,
        market_type TEXT DEFAULT 'kalshi',
        event_ticker TEXT,
        close_time TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        filled_at TEXT,
        settled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_live_trades_status ON live_trades(status);
      CREATE INDEX IF NOT EXISTS idx_live_trades_run_id ON live_trades(run_id);
    `);
  } catch {
    /* table already exists */
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
  };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
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
    };
  }
  return result;
}

// --- Monitor query functions ---

export function getRecentMessages(chatJid?: string, limit = 50): Array<{
  id: string;
  chat_jid: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}> {
  const clampedLimit = Math.min(Math.max(1, limit), 200);
  if (chatJid) {
    return db
      .prepare(
        `SELECT id, chat_jid, sender_name, content, timestamp, is_from_me, is_bot_message
         FROM messages WHERE chat_jid = ?
         ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(chatJid, clampedLimit) as any[];
  }
  return db
    .prepare(
      `SELECT id, chat_jid, sender_name, content, timestamp, is_from_me, is_bot_message
       FROM messages
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(clampedLimit) as any[];
}

export function getMessageCountToday(): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM messages WHERE timestamp >= ?`)
    .get(today.toISOString()) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getTaskRunLogs(taskId?: string, limit = 50): Array<{
  id: number;
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}> {
  const clampedLimit = Math.min(Math.max(1, limit), 200);
  if (taskId) {
    return db
      .prepare(
        `SELECT id, task_id, run_at, duration_ms, status, result, error
         FROM task_run_logs WHERE task_id = ?
         ORDER BY run_at DESC LIMIT ?`,
      )
      .all(taskId, clampedLimit) as any[];
  }
  return db
    .prepare(
      `SELECT id, task_id, run_at, duration_ms, status, result, error
       FROM task_run_logs
       ORDER BY run_at DESC LIMIT ?`,
    )
    .all(clampedLimit) as any[];
}

// --- User accessors ---

export function createUser(user: User): void {
  db.prepare(
    `INSERT OR REPLACE INTO users (id, name, phone, email, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(user.id, user.name, user.phone, user.email, user.role, user.created_at);
}

export function getUserByPhone(phone: string): User | undefined {
  return db
    .prepare('SELECT * FROM users WHERE phone = ?')
    .get(phone) as User | undefined;
}

export function getUserByEmail(email: string): User | undefined {
  return db
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(email) as User | undefined;
}

export function getAllUsers(): User[] {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all() as User[];
}

export function deleteUser(id: string): void {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// --- Trading Preset accessors ---

export function createPreset(preset: TradingPreset): void {
  db.prepare(
    `INSERT INTO trading_presets (id, name, platform, strategy, mode, initial_capital, risk_params, schedule_type, schedule_value, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    preset.id, preset.name, preset.platform, preset.strategy, preset.mode,
    preset.initial_capital, preset.risk_params, preset.schedule_type,
    preset.schedule_value, preset.notes, preset.created_at, preset.updated_at,
  );
}

export function getAllPresets(): TradingPreset[] {
  return db.prepare('SELECT * FROM trading_presets ORDER BY updated_at DESC').all() as TradingPreset[];
}

export function getPresetById(id: string): TradingPreset | undefined {
  return db.prepare('SELECT * FROM trading_presets WHERE id = ?').get(id) as TradingPreset | undefined;
}

export function updatePreset(id: string, updates: Partial<Omit<TradingPreset, 'id' | 'created_at'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE trading_presets SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deletePreset(id: string): void {
  db.prepare('DELETE FROM trading_presets WHERE id = ?').run(id);
}

// --- Trading Run accessors ---

export function createRun(run: TradingRun): void {
  db.prepare(
    `INSERT INTO trading_runs (id, preset_id, task_id, type, status, platform, strategy, mode, initial_capital, risk_params, start_date, end_date, results, created_at, completed_at, error, last_snapshot_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id, run.preset_id, run.task_id, run.type, run.status, run.platform,
    run.strategy, run.mode, run.initial_capital, run.risk_params,
    run.start_date, run.end_date, run.results, run.created_at,
    run.completed_at, run.error, run.last_snapshot_at,
  );
}

export function getAllRuns(type?: string, status?: string): TradingRun[] {
  let sql = 'SELECT * FROM trading_runs WHERE 1=1';
  const params: unknown[] = [];
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params) as TradingRun[];
}

export function getRunById(id: string): TradingRun | undefined {
  return db.prepare('SELECT * FROM trading_runs WHERE id = ?').get(id) as TradingRun | undefined;
}

export function updateRun(id: string, updates: Partial<Pick<TradingRun, 'status' | 'task_id' | 'results' | 'completed_at' | 'error' | 'last_snapshot_at'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.task_id !== undefined) { fields.push('task_id = ?'); values.push(updates.task_id); }
  if (updates.results !== undefined) { fields.push('results = ?'); values.push(updates.results); }
  if (updates.completed_at !== undefined) { fields.push('completed_at = ?'); values.push(updates.completed_at); }
  if (updates.error !== undefined) { fields.push('error = ?'); values.push(updates.error); }
  if (updates.last_snapshot_at !== undefined) { fields.push('last_snapshot_at = ?'); values.push(updates.last_snapshot_at); }

  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE trading_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getRunningStrategyRuns(): TradingRun[] {
  return db.prepare(
    "SELECT * FROM trading_runs WHERE type = 'strategy_engine' AND status = 'running'",
  ).all() as TradingRun[];
}

// --- Account Config accessors ---

export function getAccountConfig(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM account_config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setAccountConfig(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO account_config (key, value, updated_at) VALUES (?, ?, ?)',
  ).run(key, value, new Date().toISOString());
}

export function getAllAccountConfig(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM account_config').all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

// --- Market Watcher accessors ---

export function createWatcher(watcher: MarketWatcher): void {
  db.prepare(
    `INSERT INTO market_watchers (id, name, token_ids, market_slugs, interval_ms, duration_ms, started_at, expires_at, status, data_points)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    watcher.id, watcher.name, watcher.token_ids, watcher.market_slugs,
    watcher.interval_ms, watcher.duration_ms, watcher.started_at,
    watcher.expires_at, watcher.status, watcher.data_points,
  );
}

export function getWatcher(id: string): MarketWatcher | undefined {
  return db.prepare('SELECT * FROM market_watchers WHERE id = ?').get(id) as MarketWatcher | undefined;
}

export function getAllWatchers(status?: string): MarketWatcher[] {
  if (status) {
    return db.prepare('SELECT * FROM market_watchers WHERE status = ? ORDER BY started_at DESC').all(status) as MarketWatcher[];
  }
  return db.prepare('SELECT * FROM market_watchers ORDER BY started_at DESC').all() as MarketWatcher[];
}

export function updateWatcher(id: string, updates: Partial<Pick<MarketWatcher, 'status' | 'data_points'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.data_points !== undefined) { fields.push('data_points = ?'); values.push(updates.data_points); }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE market_watchers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function storeMarketDataPoint(point: {
  platform: string;
  symbol: string;
  timestamp: string;
  price: number;
  volume?: number;
  open_interest?: number;
  metadata?: string;
}): void {
  db.prepare(
    `INSERT INTO market_data (platform, symbol, timestamp, price, volume, open_interest, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(point.platform, point.symbol, point.timestamp, point.price, point.volume ?? null, point.open_interest ?? null, point.metadata ?? null);
}

export function getRecordedData(watcherId: string, tokenId?: string, limit?: number, offset?: number, order?: 'ASC' | 'DESC'): Array<{
  id: number;
  platform: string;
  symbol: string;
  timestamp: string;
  price: number;
  volume: number | null;
  open_interest: number | null;
  metadata: string | null;
}> {
  let sql = `SELECT * FROM market_data WHERE metadata LIKE ?`;
  const params: unknown[] = [`%"watcher_id":"${watcherId}"%`];
  if (tokenId) {
    sql += ` AND symbol = ?`;
    params.push(tokenId);
  }
  sql += ` ORDER BY timestamp ${order === 'DESC' ? 'DESC' : 'ASC'}`;
  if (limit) {
    sql += ` LIMIT ?`;
    params.push(limit);
  }
  if (offset) {
    sql += ` OFFSET ?`;
    params.push(offset);
  }
  return db.prepare(sql).all(...params) as any[];
}

export function getMarketDataBySlug(slug: string, outcome?: string): Array<{
  timestamp: string;
  price: number;
  metadata: string | null;
}> {
  let sql = `SELECT timestamp, price, metadata FROM market_data WHERE metadata LIKE ?`;
  const params: unknown[] = [`%"market_slug":"${slug}"%`];
  if (outcome) {
    sql += ` AND metadata LIKE ?`;
    params.push(`%"outcome":"${outcome}"%`);
  }
  sql += ` ORDER BY timestamp DESC LIMIT 30`;
  return db.prepare(sql).all(...params) as any[];
}

// --- Optimization Result accessors ---

export function createOptimizationResult(result: OptimizationResult): void {
  db.prepare(
    `INSERT INTO optimization_results (id, watcher_id, strategy, param_ranges, results, optimize_for, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(result.id, result.watcher_id, result.strategy, result.param_ranges, result.results, result.optimize_for, result.created_at);
}

export function getOptimizationResult(id: string): OptimizationResult | undefined {
  return db.prepare('SELECT * FROM optimization_results WHERE id = ?').get(id) as OptimizationResult | undefined;
}

export function getOptimizationResults(watcherId?: string): OptimizationResult[] {
  if (watcherId) {
    return db.prepare('SELECT * FROM optimization_results WHERE watcher_id = ? ORDER BY created_at DESC').all(watcherId) as OptimizationResult[];
  }
  return db.prepare('SELECT * FROM optimization_results ORDER BY created_at DESC').all() as OptimizationResult[];
}

// --- Paper Trade accessors ---

export function createPaperTrade(trade: PaperTrade): void {
  db.prepare(
    `INSERT INTO paper_trades (id, ticker, market_title, side, action, qty, entry_price, exit_price, status, strategy, run_id, market_type, event_ticker, close_time, notes, created_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    trade.id, trade.ticker, trade.market_title, trade.side, trade.action,
    trade.qty, trade.entry_price, trade.exit_price, trade.status,
    trade.strategy || 'uncategorized', trade.run_id || null,
    trade.market_type, trade.event_ticker, trade.close_time, trade.notes,
    trade.created_at, trade.settled_at,
  );
}

export function getAllPaperTrades(status?: string, runId?: string): PaperTrade[] {
  let sql = 'SELECT * FROM paper_trades WHERE 1=1';
  const params: unknown[] = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (runId) { sql += ' AND run_id = ?'; params.push(runId); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params) as PaperTrade[];
}

export function deletePaperTradesByRunId(runId: string): number {
  const result = db.prepare('DELETE FROM paper_trades WHERE run_id = ?').run(runId);
  return result.changes;
}

export function getPaperTradeById(id: string): PaperTrade | undefined {
  return db.prepare('SELECT * FROM paper_trades WHERE id = ?').get(id) as PaperTrade | undefined;
}

export function updatePaperTrade(id: string, updates: Partial<Pick<PaperTrade, 'exit_price' | 'status' | 'settled_at' | 'notes' | 'strategy'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.exit_price !== undefined) { fields.push('exit_price = ?'); values.push(updates.exit_price); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.settled_at !== undefined) { fields.push('settled_at = ?'); values.push(updates.settled_at); }
  if (updates.notes !== undefined) { fields.push('notes = ?'); values.push(updates.notes); }
  if (updates.strategy !== undefined) { fields.push('strategy = ?'); values.push(updates.strategy); }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE paper_trades SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deletePaperTrade(id: string): void {
  db.prepare('DELETE FROM paper_trades WHERE id = ?').run(id);
}

export function getOpenPaperTradesForTicker(ticker: string): PaperTrade[] {
  return db.prepare(
    'SELECT * FROM paper_trades WHERE ticker = ? AND status = ? ORDER BY created_at DESC',
  ).all(ticker, 'open') as PaperTrade[];
}

export function getExpiredOpenPaperTrades(): PaperTrade[] {
  return db.prepare(
    `SELECT * FROM paper_trades WHERE status = 'open' AND close_time IS NOT NULL AND close_time < datetime('now')`,
  ).all() as PaperTrade[];
}

export function getDailySettledPnl(dateStr: string): { total_pnl_cents: number; settled_count: number } {
  const row = db.prepare(
    `SELECT COALESCE(SUM((exit_price - entry_price) * qty), 0) as total_pnl_cents, COUNT(*) as settled_count FROM paper_trades WHERE settled_at IS NOT NULL AND settled_at >= ? AND status IN ('won', 'lost') AND exit_price IS NOT NULL`,
  ).get(dateStr + 'T00:00:00Z') as { total_pnl_cents: number; settled_count: number };
  return row;
}

// --- Live Trade accessors ---

export function createLiveTrade(trade: LiveTrade): void {
  db.prepare(
    `INSERT INTO live_trades (id, kalshi_order_id, ticker, market_title, side, action, qty, entry_price, fill_price, exit_price, status, strategy, run_id, market_type, event_ticker, close_time, notes, created_at, filled_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    trade.id, trade.kalshi_order_id, trade.ticker, trade.market_title, trade.side,
    trade.action, trade.qty, trade.entry_price, trade.fill_price, trade.exit_price,
    trade.status, trade.strategy, trade.run_id, trade.market_type,
    trade.event_ticker, trade.close_time, trade.notes, trade.created_at,
    trade.filled_at, trade.settled_at,
  );
}

export function getAllLiveTrades(status?: string): LiveTrade[] {
  if (status) {
    return db.prepare('SELECT * FROM live_trades WHERE status = ? ORDER BY created_at DESC').all(status) as LiveTrade[];
  }
  return db.prepare('SELECT * FROM live_trades ORDER BY created_at DESC').all() as LiveTrade[];
}

export function getLiveTradeById(id: string): LiveTrade | undefined {
  return db.prepare('SELECT * FROM live_trades WHERE id = ?').get(id) as LiveTrade | undefined;
}

export function updateLiveTrade(id: string, updates: Partial<Pick<LiveTrade, 'fill_price' | 'exit_price' | 'status' | 'settled_at' | 'kalshi_order_id' | 'notes' | 'filled_at'>>): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.fill_price !== undefined) { fields.push('fill_price = ?'); values.push(updates.fill_price); }
  if (updates.exit_price !== undefined) { fields.push('exit_price = ?'); values.push(updates.exit_price); }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }
  if (updates.settled_at !== undefined) { fields.push('settled_at = ?'); values.push(updates.settled_at); }
  if (updates.kalshi_order_id !== undefined) { fields.push('kalshi_order_id = ?'); values.push(updates.kalshi_order_id); }
  if (updates.notes !== undefined) { fields.push('notes = ?'); values.push(updates.notes); }
  if (updates.filled_at !== undefined) { fields.push('filled_at = ?'); values.push(updates.filled_at); }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE live_trades SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getOpenLiveTrades(): LiveTrade[] {
  return db.prepare(
    `SELECT * FROM live_trades WHERE status IN ('pending', 'filled') ORDER BY created_at DESC`,
  ).all() as LiveTrade[];
}

export function getLiveTradeByOrderId(kalshiOrderId: string): LiveTrade | undefined {
  return db.prepare('SELECT * FROM live_trades WHERE kalshi_order_id = ?').get(kalshiOrderId) as LiveTrade | undefined;
}

export function getOpenLiveTradesForTicker(ticker: string): LiveTrade[] {
  return db.prepare(
    `SELECT * FROM live_trades WHERE ticker = ? AND status IN ('pending', 'filled') ORDER BY created_at DESC`,
  ).all(ticker) as LiveTrade[];
}

export function markOrphanedRunsStopped(): number {
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE trading_runs SET status = 'stopped', completed_at = ?, error = 'Orphaned by service restart' WHERE status IN ('pending', 'running') AND type != 'strategy_engine'`,
  ).run(now);
  return result.changes;
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
