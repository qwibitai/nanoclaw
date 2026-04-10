import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import type {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from '../types.js';
import {
  mapRowToRegisteredGroup,
  serializeRegisteredGroup,
} from './helpers.js';
import type {
  ChatInfo,
  IDatabaseAdapter,
  RegisteredGroupRow,
  TaskUpdates,
} from './types.js';

export class SqliteAdapter implements IDatabaseAdapter {
  private db!: Database.Database;

  async init(): Promise<void> {
    const dbPath = path.join(STORE_DIR, 'messages.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.createSchema();
    this.migrateJsonState();
  }

  async close(): Promise<void> {
    this.db?.close();
  }

  async initTest(): Promise<void> {
    this.db = new Database(':memory:');
    this.createSchema();
  }

  // -- Schema & migrations ------------------------------------------------

  private createSchema(): void {
    this.db.exec(`
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

    try {
      this.db.exec(
        `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
      );
    } catch {
      /* column already exists */
    }

    try {
      this.db.exec(
        `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
      );
      this.db
        .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
        .run(`${ASSISTANT_NAME}:%`);
    } catch {
      /* column already exists */
    }

    try {
      this.db.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
      this.db.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
      this.db.exec(
        `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
      );
      this.db.exec(
        `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
      );
      this.db.exec(
        `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
      );
      this.db.exec(
        `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
      );
    } catch {
      /* columns already exist */
    }

    try {
      this.db.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
    } catch {
      /* column already exists */
    }

    try {
      this.db.exec(
        `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
      );
      this.db.exec(
        `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
      );
    } catch {
      /* column already exists */
    }

    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
      this.db.exec(
        `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
      );
      this.db.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
    } catch {
      /* columns already exist */
    }
  }

  private migrateJsonState(): void {
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

    const routerState = migrateFile('router_state.json') as {
      last_timestamp?: string;
      last_agent_timestamp?: Record<string, string>;
    } | null;
    if (routerState) {
      if (routerState.last_timestamp) {
        this.db
          .prepare(
            'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
          )
          .run('last_timestamp', routerState.last_timestamp);
      }
      if (routerState.last_agent_timestamp) {
        this.db
          .prepare(
            'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
          )
          .run(
            'last_agent_timestamp',
            JSON.stringify(routerState.last_agent_timestamp),
          );
      }
    }

    const sessions = migrateFile('sessions.json') as Record<
      string,
      string
    > | null;
    if (sessions) {
      for (const [folder, sessionId] of Object.entries(sessions)) {
        this.db
          .prepare(
            'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
          )
          .run(folder, sessionId);
      }
    }

    const groups = migrateFile('registered_groups.json') as Record<
      string,
      RegisteredGroup
    > | null;
    if (groups) {
      for (const [jid, group] of Object.entries(groups)) {
        try {
          this.db
            .prepare(
              `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(...serializeRegisteredGroup(jid, group));
        } catch (err) {
          logger.warn(
            { jid, folder: group.folder, err },
            'Skipping migrated registered group with invalid folder',
          );
        }
      }
    }
  }

  // -- Chats --------------------------------------------------------------

  async storeChatMetadata(
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ): Promise<void> {
    const ch = channel ?? null;
    const group = isGroup === undefined ? null : isGroup ? 1 : 0;

    if (name) {
      this.db
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)`,
        )
        .run(chatJid, name, timestamp, ch, group);
    } else {
      this.db
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)`,
        )
        .run(chatJid, chatJid, timestamp, ch, group);
    }
  }

  async updateChatName(chatJid: string, name: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name`,
      )
      .run(chatJid, name, new Date().toISOString());
  }

  async getAllChats(): Promise<ChatInfo[]> {
    return this.db
      .prepare(
        `SELECT jid, name, last_message_time, channel, is_group
    FROM chats ORDER BY last_message_time DESC`,
      )
      .all() as ChatInfo[];
  }

  async getLastGroupSync(): Promise<string | null> {
    const row = this.db
      .prepare(
        `SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`,
      )
      .get() as { last_message_time: string } | undefined;
    return row?.last_message_time || null;
  }

  async setLastGroupSync(): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
      )
      .run(now);
  }

  // -- Messages -----------------------------------------------------------

  async storeMessage(msg: NewMessage): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.id,
        msg.chat_jid,
        msg.sender,
        msg.sender_name,
        msg.content,
        msg.timestamp,
        msg.is_from_me ? 1 : 0,
        msg.is_bot_message ? 1 : 0,
        msg.reply_to_message_id ?? null,
        msg.reply_to_message_content ?? null,
        msg.reply_to_sender_name ?? null,
      );
  }

  async storeMessageDirect(msg: {
    id: string;
    chat_jid: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: boolean;
    is_bot_message?: boolean;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

  async getNewMessages(
    jids: string[],
    lastTimestamp: string,
    botPrefix: string,
    limit: number = 200,
  ): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
    if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

    const placeholders = jids.map(() => '?').join(',');
    const sql = `
      SELECT * FROM (
        SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
               reply_to_message_id, reply_to_message_content, reply_to_sender_name
        FROM messages
        WHERE timestamp > ? AND chat_jid IN (${placeholders})
          AND is_bot_message = 0 AND content NOT LIKE ?
          AND content != '' AND content IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ?
      ) ORDER BY timestamp
    `;

    const rows = this.db
      .prepare(sql)
      .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

    let newTimestamp = lastTimestamp;
    for (const row of rows) {
      if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
    }

    return { messages: rows, newTimestamp };
  }

  async getMessagesSince(
    chatJid: string,
    sinceTimestamp: string,
    botPrefix: string,
    limit: number = 200,
  ): Promise<NewMessage[]> {
    const sql = `
      SELECT * FROM (
        SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
               reply_to_message_id, reply_to_message_content, reply_to_sender_name
        FROM messages
        WHERE chat_jid = ? AND timestamp > ?
          AND is_bot_message = 0 AND content NOT LIKE ?
          AND content != '' AND content IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT ?
      ) ORDER BY timestamp
    `;
    return this.db
      .prepare(sql)
      .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
  }

  async getLastBotMessageTimestamp(
    chatJid: string,
    botPrefix: string,
  ): Promise<string | undefined> {
    const row = this.db
      .prepare(
        `SELECT MAX(timestamp) as ts FROM messages
         WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
      )
      .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
    return row?.ts ?? undefined;
  }

  // -- Tasks --------------------------------------------------------------

  async createTask(
    task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.group_folder,
        task.chat_jid,
        task.prompt,
        task.script ?? null,
        task.schedule_type,
        task.schedule_value,
        task.context_mode || 'isolated',
        task.next_run,
        task.status,
        task.created_at,
      );
  }

  async getTaskById(id: string): Promise<ScheduledTask | undefined> {
    return this.db
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
      .get(id) as ScheduledTask | undefined;
  }

  async getTasksForGroup(groupFolder: string): Promise<ScheduledTask[]> {
    return this.db
      .prepare(
        'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
      )
      .all(groupFolder) as ScheduledTask[];
  }

  async getAllTasks(): Promise<ScheduledTask[]> {
    return this.db
      .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
      .all() as ScheduledTask[];
  }

  async updateTask(id: string, updates: TaskUpdates): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.prompt !== undefined) {
      fields.push('prompt = ?');
      values.push(updates.prompt);
    }
    if (updates.script !== undefined) {
      fields.push('script = ?');
      values.push(updates.script);
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
    this.db
      .prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values);
  }

  async deleteTask(id: string): Promise<void> {
    this.db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
    this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  }

  async getDueTasks(): Promise<ScheduledTask[]> {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run`,
      )
      .all(now) as ScheduledTask[];
  }

  async updateTaskAfterRun(
    id: string,
    nextRun: string | null,
    lastResult: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?`,
      )
      .run(nextRun, now, lastResult, nextRun, id);
  }

  async logTaskRun(log: TaskRunLog): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        log.task_id,
        log.run_at,
        log.duration_ms,
        log.status,
        log.result,
        log.error,
      );
  }

  // -- Router state -------------------------------------------------------

  async getRouterState(key: string): Promise<string | undefined> {
    const row = this.db
      .prepare('SELECT value FROM router_state WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  async setRouterState(key: string, value: string): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  // -- Sessions -----------------------------------------------------------

  async getSession(groupFolder: string): Promise<string | undefined> {
    const row = this.db
      .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
      .get(groupFolder) as { session_id: string } | undefined;
    return row?.session_id;
  }

  async setSession(groupFolder: string, sessionId: string): Promise<void> {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
      )
      .run(groupFolder, sessionId);
  }

  async deleteSession(groupFolder: string): Promise<void> {
    this.db
      .prepare('DELETE FROM sessions WHERE group_folder = ?')
      .run(groupFolder);
  }

  async getAllSessions(): Promise<Record<string, string>> {
    const rows = this.db
      .prepare('SELECT group_folder, session_id FROM sessions')
      .all() as Array<{ group_folder: string; session_id: string }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.group_folder] = row.session_id;
    }
    return result;
  }

  // -- Registered groups --------------------------------------------------

  async getRegisteredGroup(
    jid: string,
  ): Promise<(RegisteredGroup & { jid: string }) | undefined> {
    const row = this.db
      .prepare('SELECT * FROM registered_groups WHERE jid = ?')
      .get(jid) as RegisteredGroupRow | undefined;
    if (!row) return undefined;
    return mapRowToRegisteredGroup(row);
  }

  async setRegisteredGroup(jid: string, group: RegisteredGroup): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...serializeRegisteredGroup(jid, group));
  }

  async getAllRegisteredGroups(): Promise<Record<string, RegisteredGroup>> {
    const rows = this.db
      .prepare('SELECT * FROM registered_groups')
      .all() as RegisteredGroupRow[];
    const result: Record<string, RegisteredGroup> = {};
    for (const row of rows) {
      const mapped = mapRowToRegisteredGroup(row);
      if (mapped) {
        const { jid: _, ...rest } = mapped;
        result[row.jid] = rest;
      }
    }
    return result;
  }
}
