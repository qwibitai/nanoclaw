/**
 * ThagomizerClaw — Cloudflare D1 Database Adapter
 *
 * Drop-in replacement for the SQLite adapter (src/db.ts) using Cloudflare D1.
 * D1 is SQLite-compatible but uses async/await instead of synchronous calls.
 *
 * Schema is defined in migrations/0001_initial.sql
 */

import type {
  AgentSession,
  ChatInfo,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

// ─── Chat Metadata ────────────────────────────────────────────────────────────

export async function storeChatMetadata(
  db: D1Database,
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): Promise<void> {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    await db
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET
           name = excluded.name,
           last_message_time = MAX(last_message_time, excluded.last_message_time),
           channel = COALESCE(excluded.channel, channel),
           is_group = COALESCE(excluded.is_group, is_group)`,
      )
      .bind(chatJid, name, timestamp, ch, group)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET
           last_message_time = MAX(last_message_time, excluded.last_message_time),
           channel = COALESCE(excluded.channel, channel),
           is_group = COALESCE(excluded.is_group, is_group)`,
      )
      .bind(chatJid, chatJid, timestamp, ch, group)
      .run();
  }
}

export async function getAllChats(db: D1Database): Promise<ChatInfo[]> {
  const result = await db
    .prepare(
      `SELECT jid, name, last_message_time, channel, is_group
       FROM chats ORDER BY last_message_time DESC`,
    )
    .all<ChatInfo>();
  return result.results;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export async function storeMessage(
  db: D1Database,
  msg: NewMessage,
  assistantName: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO messages
         (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      msg.id,
      msg.chat_jid,
      msg.sender,
      msg.sender_name,
      msg.content,
      msg.timestamp,
      msg.is_from_me ? 1 : 0,
      msg.is_bot_message
        ? 1
        : msg.content.startsWith(`${assistantName}:`)
          ? 1
          : 0,
    )
    .run();
}

export async function getNewMessages(
  db: D1Database,
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit = 200,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp`;

  const result = await db
    .prepare(sql)
    .bind(lastTimestamp, ...jids, `${botPrefix}:%`, limit)
    .all<NewMessage>();

  let newTimestamp = lastTimestamp;
  for (const row of result.results) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: result.results, newTimestamp };
}

export async function getMessagesSince(
  db: D1Database,
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit = 200,
): Promise<NewMessage[]> {
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp`;

  const result = await db
    .prepare(sql)
    .bind(chatJid, sinceTimestamp, `${botPrefix}:%`, limit)
    .all<NewMessage>();

  return result.results;
}

// ─── Registered Groups ────────────────────────────────────────────────────────

export async function getRegisteredGroup(
  db: D1Database,
  jid: string,
): Promise<(RegisteredGroup & { jid: string }) | null> {
  const row = await db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .bind(jid)
    .first<{
      jid: string;
      name: string;
      folder: string;
      trigger_pattern: string;
      added_at: string;
      agent_config: string | null;
      requires_trigger: number | null;
      is_main: number | null;
    }>();

  if (!row) return null;

  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    agentConfig: row.agent_config ? JSON.parse(row.agent_config) : undefined,
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export async function setRegisteredGroup(
  db: D1Database,
  jid: string,
  group: RegisteredGroup,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO registered_groups
         (jid, name, folder, trigger_pattern, added_at, agent_config, requires_trigger, is_main)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      jid,
      group.name,
      group.folder,
      group.trigger,
      group.added_at,
      group.agentConfig ? JSON.stringify(group.agentConfig) : null,
      group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
      group.isMain ? 1 : 0,
    )
    .run();
}

export async function getAllRegisteredGroups(
  db: D1Database,
): Promise<Record<string, RegisteredGroup>> {
  const result = await db
    .prepare('SELECT * FROM registered_groups')
    .all<{
      jid: string;
      name: string;
      folder: string;
      trigger_pattern: string;
      added_at: string;
      agent_config: string | null;
      requires_trigger: number | null;
      is_main: number | null;
    }>();

  const groups: Record<string, RegisteredGroup> = {};
  for (const row of result.results) {
    groups[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      agentConfig: row.agent_config ? JSON.parse(row.agent_config) : undefined,
      requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return groups;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export async function getSession(
  db: D1Database,
  groupFolder: string,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .bind(groupFolder)
    .first<{ session_id: string }>();
  return row?.session_id ?? null;
}

export async function setSession(
  db: D1Database,
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO sessions (group_folder, session_id, updated_at) VALUES (?, ?, ?)`,
    )
    .bind(groupFolder, sessionId, now)
    .run();
}

export async function getAllSessions(
  db: D1Database,
): Promise<Record<string, string>> {
  const result = await db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all<{ group_folder: string; session_id: string }>();

  const sessions: Record<string, string> = {};
  for (const row of result.results) {
    sessions[row.group_folder] = row.session_id;
  }
  return sessions;
}

// ─── Router State (KV-backed for low latency) ────────────────────────────────

export async function getRouterState(
  kv: KVNamespace,
  key: string,
): Promise<string | null> {
  return kv.get(`router_state:${key}`);
}

export async function setRouterState(
  kv: KVNamespace,
  key: string,
  value: string,
): Promise<void> {
  await kv.put(`router_state:${key}`, value);
}

// ─── Scheduled Tasks ──────────────────────────────────────────────────────────

export async function createTask(
  db: D1Database,
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO scheduled_tasks
         (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
          context_mode, next_run, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
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
    )
    .run();
}

export async function getDueTasks(db: D1Database): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `SELECT * FROM scheduled_tasks
       WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
       ORDER BY next_run`,
    )
    .bind(now)
    .all<ScheduledTask>();
  return result.results;
}

export async function getAllTasks(db: D1Database): Promise<ScheduledTask[]> {
  const result = await db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all<ScheduledTask>();
  return result.results;
}

export async function updateTaskAfterRun(
  db: D1Database,
  id: string,
  nextRun: string | null,
  lastResult: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE scheduled_tasks
       SET next_run = ?, last_run = ?, last_result = ?,
           status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
       WHERE id = ?`,
    )
    .bind(nextRun, now, lastResult, nextRun, id)
    .run();
}

export async function updateTaskStatus(
  db: D1Database,
  id: string,
  status: 'active' | 'paused' | 'completed',
): Promise<void> {
  await db
    .prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?')
    .bind(status, id)
    .run();
}

export async function logTaskRun(
  db: D1Database,
  log: TaskRunLog,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      log.task_id,
      log.run_at,
      log.duration_ms,
      log.status,
      log.result,
      log.error,
    )
    .run();
}
