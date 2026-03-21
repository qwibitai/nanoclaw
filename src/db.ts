/**
 * db.ts — PostgreSQL data layer for nanoclaw
 *
 * Single pg.Pool, all functions async.
 * Schema is managed by Prisma (platform/api/prisma/schema.prisma).
 * nanoclaw reads/writes directly via SQL — no Prisma dependency here.
 */

import pg from 'pg';

import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let pool: pg.Pool;

export function initDatabase(): void {
  const env = readEnvFile(['DATABASE_URL']);
  const databaseUrl = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required — set it in .env or environment',
    );
  }
  pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  pool.on('error', (err) => logger.warn({ err }, 'pg: pool error'));
  logger.info('Database pool initialized (PostgreSQL)');
}

/** @internal - for tests only. Accepts a PostgreSQL connection string. */
export function _initTestDatabase(databaseUrl: string): void {
  pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
}

// ─── Query helpers ─────────────────────────────────────────────────────────────

async function q<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

async function qOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<T | undefined> {
  const result = await pool.query(sql, params);
  return result.rows[0] as T | undefined;
}

// ─── Chats ────────────────────────────────────────────────────────────────────

export async function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): Promise<void> {
  const ts = new Date(timestamp);
  if (name) {
    await q(
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (jid) DO UPDATE SET
         name = EXCLUDED.name,
         last_message_time = GREATEST(chats.last_message_time, EXCLUDED.last_message_time),
         channel = COALESCE(EXCLUDED.channel, chats.channel),
         is_group = COALESCE(EXCLUDED.is_group, chats.is_group)`,
      [chatJid, name, ts, channel ?? null, isGroup ?? null],
    );
  } else {
    await q(
      `INSERT INTO chats (jid, name, last_message_time, channel, is_group)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (jid) DO UPDATE SET
         last_message_time = GREATEST(chats.last_message_time, EXCLUDED.last_message_time),
         channel = COALESCE(EXCLUDED.channel, chats.channel),
         is_group = COALESCE(EXCLUDED.is_group, chats.is_group)`,
      [chatJid, chatJid, ts, channel ?? null, isGroup ?? null],
    );
  }
}

export async function updateChatName(
  chatJid: string,
  name: string,
): Promise<void> {
  await q(
    `INSERT INTO chats (jid, name, last_message_time)
     VALUES ($1,$2,$3)
     ON CONFLICT (jid) DO UPDATE SET name = EXCLUDED.name`,
    [chatJid, name, new Date()],
  );
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number; // kept as 0/1 for compatibility with existing callers
}

export async function getAllChats(): Promise<ChatInfo[]> {
  const rows = await q<{
    jid: string;
    name: string;
    last_message_time: Date | null;
    channel: string | null;
    is_group: boolean;
  }>(
    `SELECT jid, name, last_message_time, channel, is_group
     FROM chats
     WHERE jid != '__group_sync__'
     ORDER BY last_message_time DESC NULLS LAST`,
  );
  return rows.map((r) => ({
    jid: r.jid,
    name: r.name,
    last_message_time: r.last_message_time
      ? new Date(r.last_message_time).toISOString()
      : '',
    channel: r.channel ?? '',
    is_group: r.is_group ? 1 : 0,
  }));
}

export async function getLastGroupSync(): Promise<string | null> {
  const row = await qOne<{ last_message_time: Date | null }>(
    `SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`,
  );
  return row?.last_message_time
    ? new Date(row.last_message_time).toISOString()
    : null;
}

export async function setLastGroupSync(): Promise<void> {
  await q(
    `INSERT INTO chats (jid, name, last_message_time)
     VALUES ('__group_sync__','__group_sync__',$1)
     ON CONFLICT (jid) DO UPDATE SET last_message_time = EXCLUDED.last_message_time`,
    [new Date()],
  );
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export async function storeMessage(msg: NewMessage): Promise<void> {
  await q(
    `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id, chat_jid) DO UPDATE SET
       content = EXCLUDED.content,
       is_from_me = EXCLUDED.is_from_me,
       is_bot_message = EXCLUDED.is_bot_message`,
    [
      msg.id,
      msg.chat_jid,
      msg.sender ?? null,
      msg.sender_name ?? null,
      msg.content ?? null,
      new Date(msg.timestamp),
      msg.is_from_me ?? false,
      msg.is_bot_message ?? false,
    ],
  );
}

export async function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): Promise<void> {
  await storeMessage(msg);
}

type MessageRow = {
  id: string;
  chat_jid: string;
  sender: string | null;
  sender_name: string | null;
  content: string | null;
  timestamp: Date;
  is_from_me: boolean;
};

function mapMessage(row: MessageRow): NewMessage {
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    sender: row.sender ?? '',
    sender_name: row.sender_name ?? '',
    content: row.content ?? '',
    timestamp: new Date(row.timestamp).toISOString(),
    is_from_me: row.is_from_me,
  };
}

export async function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const jidPlaceholders = jids.map((_, i) => `$${i + 3}`).join(',');
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > $1 AND chat_jid IN (${jidPlaceholders})
        AND is_bot_message = false
        AND content NOT LIKE $2
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ${limit}
    ) sub ORDER BY timestamp
  `;

  const cutoff = lastTimestamp ? new Date(lastTimestamp) : new Date(0);
  const rows = await q<MessageRow>(sql, [cutoff, `${botPrefix}:%`, ...jids]);
  const messages = rows.map(mapMessage);

  let newTimestamp = lastTimestamp;
  for (const m of messages) {
    if (m.timestamp > newTimestamp) newTimestamp = m.timestamp;
  }

  return { messages, newTimestamp };
}

export async function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): Promise<NewMessage[]> {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = $1 AND timestamp > $2
        AND is_bot_message = false
        AND content NOT LIKE $3
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ${limit}
    ) sub ORDER BY timestamp
  `;
  const cutoff = sinceTimestamp ? new Date(sinceTimestamp) : new Date(0);
  const rows = await q<MessageRow>(sql, [chatJid, cutoff, `${botPrefix}:%`]);
  return rows.map(mapMessage);
}

// ─── Scheduled tasks ──────────────────────────────────────────────────────────

type TaskRow = {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string | null;
  next_run: Date | null;
  last_run: Date | null;
  last_result: string | null;
  status: string;
  created_at: Date;
};

function mapTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    group_folder: row.group_folder,
    chat_jid: row.chat_jid,
    prompt: row.prompt,
    schedule_type: row.schedule_type as ScheduledTask['schedule_type'],
    schedule_value: row.schedule_value,
    context_mode: (row.context_mode ?? 'isolated') as ScheduledTask['context_mode'],
    next_run: row.next_run ? new Date(row.next_run).toISOString() : null,
    last_run: row.last_run ? new Date(row.last_run).toISOString() : null,
    last_result: row.last_result ?? null,
    status: (row.status ?? 'active') as ScheduledTask['status'],
    created_at: new Date(row.created_at).toISOString(),
  };
}

export async function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): Promise<void> {
  await q(
    `INSERT INTO scheduled_tasks
       (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO NOTHING`,
    [
      task.id,
      task.group_folder,
      task.chat_jid,
      task.prompt,
      task.schedule_type,
      task.schedule_value,
      task.context_mode ?? 'isolated',
      task.next_run ? new Date(task.next_run) : null,
      task.status,
      new Date(task.created_at),
    ],
  );
}

export async function getTaskById(
  id: string,
): Promise<ScheduledTask | undefined> {
  const row = await qOne<TaskRow>(
    'SELECT * FROM scheduled_tasks WHERE id = $1',
    [id],
  );
  return row ? mapTask(row) : undefined;
}

export async function getTasksForGroup(
  groupFolder: string,
): Promise<ScheduledTask[]> {
  const rows = await q<TaskRow>(
    'SELECT * FROM scheduled_tasks WHERE group_folder = $1 ORDER BY created_at DESC',
    [groupFolder],
  );
  return rows.map(mapTask);
}

export async function getAllTasks(): Promise<ScheduledTask[]> {
  const rows = await q<TaskRow>(
    'SELECT * FROM scheduled_tasks ORDER BY created_at DESC',
  );
  return rows.map(mapTask);
}

export async function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (updates.prompt !== undefined) {
    fields.push(`prompt = $${i++}`);
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push(`schedule_type = $${i++}`);
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push(`schedule_value = $${i++}`);
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push(`next_run = $${i++}`);
    values.push(updates.next_run ? new Date(updates.next_run) : null);
  }
  if (updates.status !== undefined) {
    fields.push(`status = $${i++}`);
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  await q(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = $${i}`,
    values,
  );
}

export async function deleteTask(id: string): Promise<void> {
  await q('DELETE FROM task_run_logs WHERE task_id = $1', [id]);
  await q('DELETE FROM scheduled_tasks WHERE id = $1', [id]);
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  const rows = await q<TaskRow>(
    `SELECT * FROM scheduled_tasks
     WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= NOW()
     ORDER BY next_run`,
  );
  return rows.map(mapTask);
}

export async function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): Promise<void> {
  await q(
    `UPDATE scheduled_tasks
     SET next_run = $1, last_run = NOW(), last_result = $2,
         status = CASE WHEN $1 IS NULL THEN 'completed' ELSE status END
     WHERE id = $3`,
    [nextRun ? new Date(nextRun) : null, lastResult, id],
  );
}

export async function logTaskRun(log: TaskRunLog): Promise<void> {
  await q(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      log.task_id,
      new Date(log.run_at),
      log.duration_ms,
      log.status,
      log.result,
      log.error,
    ],
  );
}

// ─── Router state ─────────────────────────────────────────────────────────────

export async function getRouterState(key: string): Promise<string | undefined> {
  const row = await qOne<{ value: string }>(
    'SELECT value FROM router_state WHERE key = $1',
    [key],
  );
  return row?.value;
}

export async function setRouterState(
  key: string,
  value: string,
): Promise<void> {
  await q(
    `INSERT INTO router_state (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export async function getSession(
  groupFolder: string,
): Promise<string | undefined> {
  const row = await qOne<{ session_id: string }>(
    'SELECT session_id FROM conversation_sessions WHERE group_folder = $1',
    [groupFolder],
  );
  return row?.session_id;
}

export async function setSession(
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  await q(
    `INSERT INTO conversation_sessions (group_folder, session_id) VALUES ($1,$2)
     ON CONFLICT (group_folder) DO UPDATE SET session_id = EXCLUDED.session_id`,
    [groupFolder, sessionId],
  );
}

export async function getAllSessions(): Promise<Record<string, string>> {
  const rows = await q<{ group_folder: string; session_id: string }>(
    'SELECT group_folder, session_id FROM conversation_sessions',
  );
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// ─── Registered groups ────────────────────────────────────────────────────────

type GroupRow = {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: Date;
  container_config: object | null;
  requires_trigger: boolean | null;
  is_main: boolean | null;
};

function mapGroup(
  row: GroupRow,
): (RegisteredGroup & { jid: string }) | undefined {
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
    added_at: new Date(row.added_at).toISOString(),
    containerConfig: (row.container_config as any) ?? undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger,
    isMain: row.is_main === true ? true : undefined,
  };
}

export async function getRegisteredGroup(
  jid: string,
): Promise<(RegisteredGroup & { jid: string }) | undefined> {
  const row = await qOne<GroupRow>(
    'SELECT * FROM registered_groups WHERE jid = $1',
    [jid],
  );
  if (!row) return undefined;
  return mapGroup(row);
}

export async function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): Promise<void> {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  await q(
    `INSERT INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (jid) DO UPDATE SET
       name = EXCLUDED.name,
       folder = EXCLUDED.folder,
       trigger_pattern = EXCLUDED.trigger_pattern,
       container_config = EXCLUDED.container_config,
       requires_trigger = EXCLUDED.requires_trigger,
       is_main = EXCLUDED.is_main`,
    [
      jid,
      group.name,
      group.folder,
      group.trigger,
      new Date(group.added_at),
      group.containerConfig ? JSON.stringify(group.containerConfig) : null,
      group.requiresTrigger !== false,
      group.isMain === true,
    ],
  );
}

export async function getAllRegisteredGroups(): Promise<
  Record<string, RegisteredGroup>
> {
  const rows = await q<GroupRow>('SELECT * FROM registered_groups');
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    const g = mapGroup(row);
    if (g) {
      const { jid, ...group } = g;
      result[jid] = group;
    }
  }
  return result;
}
