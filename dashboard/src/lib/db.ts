import Database from 'better-sqlite3';
import path from 'path';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  }
  return _db;
}

export interface GroupRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number | null;
}

export interface ChatRow {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

export interface MessageRow {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}

export interface TaskRow {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
}

export interface TaskRunLogRow {
  id: number;
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}

export interface SessionRow {
  group_folder: string;
  session_id: string;
}

export function getGroups(): GroupRow[] {
  return getDb()
    .prepare('SELECT * FROM registered_groups ORDER BY name')
    .all() as GroupRow[];
}

export function getGroupByFolder(folder: string): GroupRow | undefined {
  return getDb()
    .prepare('SELECT * FROM registered_groups WHERE folder = ?')
    .get(folder) as GroupRow | undefined;
}

export function getChats(): ChatRow[] {
  return getDb()
    .prepare('SELECT * FROM chats ORDER BY last_message_time DESC')
    .all() as ChatRow[];
}

export function getMessages(opts: {
  chatJid?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): { messages: MessageRow[]; total: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.chatJid) {
    conditions.push('m.chat_jid = ?');
    params.push(opts.chatJid);
  }
  if (opts.search) {
    conditions.push('m.content LIKE ?');
    params.push(`%${opts.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const countRow = getDb()
    .prepare(`SELECT COUNT(*) as count FROM messages m ${where}`)
    .get(...params) as { count: number };

  const messages = getDb()
    .prepare(
      `SELECT m.* FROM messages m ${where} ORDER BY m.timestamp DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as MessageRow[];

  return { messages, total: countRow.count };
}

export function getMessageCountSince(since: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as count FROM messages WHERE timestamp > ?')
    .get(since) as { count: number };
  return row.count;
}

export function getRecentMessages(limit: number): MessageRow[] {
  return getDb()
    .prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?')
    .all(limit) as MessageRow[];
}

export function getTasks(): TaskRow[] {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as TaskRow[];
}

export function getTaskRunLogs(taskId: string): TaskRunLogRow[] {
  return getDb()
    .prepare(
      'SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 50',
    )
    .all(taskId) as TaskRunLogRow[];
}

export function getSessions(): SessionRow[] {
  return getDb()
    .prepare('SELECT * FROM sessions')
    .all() as SessionRow[];
}

/** Run a read-only SQL query (for custom agent pages). */
export function runReadOnlyQuery(
  sql: string,
  params: unknown[] = [],
): unknown[] {
  const normalized = sql.trim().toUpperCase();
  if (!normalized.startsWith('SELECT')) {
    throw new Error('Only SELECT queries are allowed');
  }
  return getDb().prepare(sql).all(...params);
}
