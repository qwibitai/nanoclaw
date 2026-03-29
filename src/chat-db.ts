/**
 * chat-db.ts — SQLite persistence for the embedded chat server.
 * Uses NanoClaw's already-compiled better-sqlite3 instance.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { randomUUID } from 'crypto';
import { logger } from './logger.js';

let db: Database.Database | null = null;

export interface ChatRoom {
  id: string;
  name: string;
  created_at: number;
}

export interface ChatMessage {
  id: string;
  room_id: string;
  sender: string;
  sender_type: string;
  content: string;
  message_type: 'text' | 'file';
  file_meta?: FileMeta | null;
  created_at: number;
}

export interface FileMeta {
  url: string;
  filename: string;
  mime: string;
  size: number;
}

export interface ChatAgentToken {
  token: string;
  agent_id: string;
  name: string;
  allowed_rooms: string[] | null;
  created_at: number;
}

export function initChatDatabase(dataDir: string): void {
  const dbPath = path.join(dataDir, 'chat.sqlite');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_rooms (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id          TEXT PRIMARY KEY,
      room_id     TEXT NOT NULL REFERENCES chat_rooms(id),
      sender      TEXT NOT NULL,
      sender_type TEXT NOT NULL DEFAULT 'user',
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_msgs_room
      ON chat_messages(room_id, created_at);
    CREATE TABLE IF NOT EXISTS chat_agent_tokens (
      token        TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL,
      name         TEXT NOT NULL,
      allowed_rooms TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Migration: add message_type and file_meta columns
  const cols = db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{
    name: string;
  }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('message_type')) {
    db.exec(
      "ALTER TABLE chat_messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'text'",
    );
  }
  if (!colNames.has('file_meta')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN file_meta TEXT');
  }

  // Workflows table
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      enabled        INTEGER NOT NULL DEFAULT 1,
      steps          TEXT NOT NULL,
      created_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at     INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      last_run_at    INTEGER,
      last_run_status TEXT
    );
  `);

  // Seed default rooms
  const ins = db.prepare(
    'INSERT OR IGNORE INTO chat_rooms (id, name) VALUES (?, ?)',
  );
  ins.run('general', 'general');
  ins.run('homebot', 'homebot');
  ins.run('dev', 'dev');

  logger.info({ dbPath }, 'Chat database initialized');
}

function getDb(): Database.Database {
  if (!db)
    throw new Error('Chat DB not initialised — call initChatDatabase() first');
  return db;
}

export function getChatRooms(): ChatRoom[] {
  return getDb()
    .prepare('SELECT * FROM chat_rooms ORDER BY name')
    .all() as ChatRoom[];
}

export function getChatRoom(id: string): ChatRoom | null {
  return (
    (getDb()
      .prepare('SELECT * FROM chat_rooms WHERE id = ?')
      .get(id) as ChatRoom) ?? null
  );
}

export function createChatRoom(id: string, name: string): ChatRoom {
  getDb()
    .prepare('INSERT OR IGNORE INTO chat_rooms (id, name) VALUES (?, ?)')
    .run(id, name);
  return getChatRoom(id)!;
}

export function deleteChatRoom(id: string): void {
  getDb().prepare('DELETE FROM chat_messages WHERE room_id = ?').run(id);
  getDb().prepare('DELETE FROM chat_rooms WHERE id = ?').run(id);
}

export function getChatMessages(roomId: string, limit = 50): ChatMessage[] {
  const rows = getDb()
    .prepare(
      'SELECT * FROM chat_messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(roomId, limit) as Array<Record<string, unknown>>;
  return rows.reverse().map(parseChatMessageRow);
}

function parseChatMessageRow(row: Record<string, unknown>): ChatMessage {
  return {
    ...row,
    message_type: (row.message_type as string) || 'text',
    file_meta: row.file_meta ? JSON.parse(row.file_meta as string) : null,
  } as ChatMessage;
}

function getChatMessageById(id: string): ChatMessage | null {
  const row = getDb()
    .prepare('SELECT * FROM chat_messages WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? parseChatMessageRow(row) : null;
}

export function storeChatMessage(
  roomId: string,
  sender: string,
  senderType: string,
  content: string,
): ChatMessage {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      'INSERT INTO chat_messages (id, room_id, sender, sender_type, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, roomId, sender, senderType, content, now);
  return getChatMessageById(id)!;
}

export function storeFileMessage(
  roomId: string,
  sender: string,
  senderType: string,
  fileMeta: FileMeta,
  caption?: string,
): ChatMessage {
  const id = randomUUID();
  const now = Date.now();
  const content = caption || fileMeta.filename;
  getDb()
    .prepare(
      'INSERT INTO chat_messages (id, room_id, sender, sender_type, content, message_type, file_meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      roomId,
      sender,
      senderType,
      content,
      'file',
      JSON.stringify(fileMeta),
      now,
    );
  return getChatMessageById(id)!;
}

export function getChatAgentToken(token: string): ChatAgentToken | null {
  const row = getDb()
    .prepare('SELECT * FROM chat_agent_tokens WHERE token = ?')
    .get(token) as any;
  if (!row) return null;
  return {
    ...row,
    allowed_rooms: row.allowed_rooms ? JSON.parse(row.allowed_rooms) : null,
  };
}

export function createChatAgentToken(
  agentId: string,
  name: string,
  allowedRooms?: string[],
): { token: string } {
  const token = randomUUID();
  getDb()
    .prepare(
      'INSERT INTO chat_agent_tokens (token, agent_id, name, allowed_rooms) VALUES (?, ?, ?, ?)',
    )
    .run(
      token,
      agentId,
      name,
      allowedRooms ? JSON.stringify(allowedRooms) : null,
    );
  return { token };
}

export function listChatAgentTokens(): Omit<ChatAgentToken, 'token'>[] {
  return (
    getDb()
      .prepare(
        'SELECT agent_id, name, allowed_rooms, created_at FROM chat_agent_tokens',
      )
      .all() as any[]
  ).map((row) => ({
    ...row,
    allowed_rooms: row.allowed_rooms ? JSON.parse(row.allowed_rooms) : null,
  }));
}

// ── Workflows ─────────────────────────────────────────────────────────────
export interface WorkflowStep {
  type: 'trigger' | 'bot' | 'transform' | 'output';
  [key: string]: unknown;
}

export interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
  steps: WorkflowStep[];
  created_at: number;
  updated_at: number;
  last_run_at?: number;
  last_run_status?: string;
}

function parseWorkflowRow(row: Record<string, unknown>): Workflow {
  return {
    id: row.id as string,
    name: row.name as string,
    enabled: row.enabled === 1,
    steps: JSON.parse(row.steps as string),
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
    last_run_at: (row.last_run_at as number) || undefined,
    last_run_status: (row.last_run_status as string) || undefined,
  };
}

export function getWorkflows(): Workflow[] {
  return (
    getDb()
      .prepare('SELECT * FROM workflows ORDER BY updated_at DESC')
      .all() as Array<Record<string, unknown>>
  ).map(parseWorkflowRow);
}

export function getWorkflow(id: string): Workflow | null {
  const row = getDb()
    .prepare('SELECT * FROM workflows WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? parseWorkflowRow(row) : null;
}

export function createWorkflow(name: string, steps: WorkflowStep[]): Workflow {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      'INSERT INTO workflows (id, name, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, name, JSON.stringify(steps), now, now);
  return getWorkflow(id)!;
}

export function updateWorkflow(
  id: string,
  updates: { name?: string; steps?: WorkflowStep[]; enabled?: boolean },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.steps !== undefined) {
    fields.push('steps = ?');
    values.push(JSON.stringify(updates.steps));
  }
  if (updates.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(updates.enabled ? 1 : 0);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(Date.now());
  values.push(id);
  getDb()
    .prepare(`UPDATE workflows SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function deleteWorkflow(id: string): void {
  getDb().prepare('DELETE FROM workflows WHERE id = ?').run(id);
}
