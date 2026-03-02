/**
 * Dashboard sub-app for NanoClaw.
 * Read-only visibility into messages, tasks, groups, and system stats.
 * Mounted at /api/dashboard by the web channel.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type Database from 'better-sqlite3';

import { getDatabase, getMessageHistory } from './db.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Row types (match exact SQLite column names)
// ---------------------------------------------------------------------------

interface ChatRow {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string | null;
  is_group: number;
  message_count: number;
}

interface TaskRow {
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

interface TaskRunRow {
  id: number;
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}

interface GroupRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  requires_trigger: number | null;
}

interface MessageRow {
  id: string;
  chat_jid: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_bot_message: number;
  thread_ts: string | null;
}

// ---------------------------------------------------------------------------
// Prepared statements (cached at init)
// ---------------------------------------------------------------------------

let stmts: ReturnType<typeof prepareStatements>;

function prepareStatements(db: Database.Database) {
  return {
    totalMessages: db
      .prepare(
        `SELECT COUNT(*) FROM messages WHERE chat_jid != '__group_sync__'`,
      )
      .pluck(),

    totalChats: db
      .prepare(`SELECT COUNT(*) FROM chats WHERE jid != '__group_sync__'`)
      .pluck(),

    totalGroups: db.prepare(`SELECT COUNT(*) FROM registered_groups`).pluck(),

    activeTasks: db
      .prepare(`SELECT COUNT(*) FROM scheduled_tasks WHERE status = 'active'`)
      .pluck(),

    messagesByChannel: db.prepare(`
      SELECT COALESCE(c.channel, 'unknown') as channel, COUNT(m.id) as count
      FROM chats c
      LEFT JOIN messages m ON m.chat_jid = c.jid
      WHERE c.jid != '__group_sync__'
      GROUP BY c.channel
    `),

    recentActivity: db.prepare(`
      SELECT jid, name, channel, last_message_time
      FROM chats
      WHERE jid != '__group_sync__'
      ORDER BY last_message_time DESC
      LIMIT 10
    `),

    chatsAll: db.prepare(`
      SELECT c.jid, c.name, c.channel, c.is_group,
             c.last_message_time,
             COUNT(m.id) as message_count
      FROM chats c
      LEFT JOIN messages m ON m.chat_jid = c.jid
      WHERE c.jid != '__group_sync__'
      GROUP BY c.jid
      ORDER BY c.last_message_time DESC
    `),

    chatsFiltered: db.prepare(`
      SELECT c.jid, c.name, c.channel, c.is_group,
             c.last_message_time,
             COUNT(m.id) as message_count
      FROM chats c
      LEFT JOIN messages m ON m.chat_jid = c.jid
      WHERE c.jid != '__group_sync__'
        AND (? IS NULL OR c.channel = ?)
        AND (? IS NULL OR c.name LIKE ?)
      GROUP BY c.jid
      ORDER BY c.last_message_time DESC
    `),

    chatExists: db.prepare(`SELECT 1 FROM chats WHERE jid = ?`).pluck(),

    allGroups: db.prepare(`
      SELECT jid, name, folder, trigger_pattern, added_at, requires_trigger
      FROM registered_groups
      ORDER BY added_at DESC
    `),

    allTasks: db.prepare(`
      SELECT * FROM scheduled_tasks ORDER BY created_at DESC
    `),

    taskExists: db
      .prepare(`SELECT 1 FROM scheduled_tasks WHERE id = ?`)
      .pluck(),

    taskRuns: db.prepare(`
      SELECT id, task_id, run_at, duration_ms, status, result, error
      FROM task_run_logs
      WHERE task_id = ?
      ORDER BY run_at DESC
      LIMIT ?
    `),

    newMessagesSince: db.prepare(`
      SELECT m.id, m.chat_jid, m.sender_name, m.content,
             m.timestamp, m.is_bot_message, m.thread_ts
      FROM messages m
      WHERE m.timestamp > ?
      ORDER BY m.timestamp ASC
      LIMIT 100
    `),

    newTaskRunsSince: db.prepare(`
      SELECT id, task_id, run_at, duration_ms, status, result, error
      FROM task_run_logs
      WHERE run_at > ?
      ORDER BY run_at ASC
      LIMIT 50
    `),
  };
}

/** Call once when the web channel starts. */
export function initDashboardQueries(): void {
  stmts = prepareStatements(getDatabase());

  // Add index for SSE task run polling (idempotent)
  getDatabase().exec(
    `CREATE INDEX IF NOT EXISTS idx_task_run_logs_run_at ON task_run_logs(run_at)`,
  );
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

function getOverviewStats() {
  const db = getDatabase();
  return db.transaction(() => ({
    totalMessages: stmts.totalMessages.get() as number,
    totalChats: stmts.totalChats.get() as number,
    totalGroups: stmts.totalGroups.get() as number,
    activeTasks: stmts.activeTasks.get() as number,
    messagesByChannel: Object.fromEntries(
      (
        stmts.messagesByChannel.all() as Array<{
          channel: string;
          count: number;
        }>
      ).map((r) => [r.channel, r.count]),
    ),
    recentActivity: (
      stmts.recentActivity.all() as Array<{
        jid: string;
        name: string;
        channel: string | null;
        last_message_time: string;
      }>
    ).map((r) => ({
      chatJid: r.jid,
      chatName: r.name,
      channel: r.channel ?? 'unknown',
      lastMessageTime: r.last_message_time,
    })),
  }))();
}

function getChatsWithCounts(channel?: string, search?: string) {
  const needsFilter = channel || search;
  const rows = needsFilter
    ? (stmts.chatsFiltered.all(
        channel ?? null,
        channel ?? null,
        search ? `%${search}%` : null,
        search ? `%${search}%` : null,
      ) as ChatRow[])
    : (stmts.chatsAll.all() as ChatRow[]);

  return rows.map((r) => ({
    jid: r.jid,
    name: r.name,
    channel: r.channel ?? 'unknown',
    isGroup: r.is_group === 1,
    lastMessageTime: r.last_message_time,
    messageCount: r.message_count,
  }));
}

function deriveChannel(jid: string): string {
  if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net'))
    return 'whatsapp';
  if (jid.startsWith('slack:') || jid.startsWith('sl:')) return 'slack';
  if (jid.startsWith('gh:') || jid.includes('@github')) return 'github';
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('dc:')) return 'discord';
  if (jid.endsWith('@web')) return 'web';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}

// ---------------------------------------------------------------------------
// SSE state
// ---------------------------------------------------------------------------

let sseConnectionCount = 0;
const MAX_SSE_CONNECTIONS = 10;
let globalEventId = 0;

// ---------------------------------------------------------------------------
// Hono sub-app
// ---------------------------------------------------------------------------

export const dashboardApp = new Hono();

// Add Cache-Control to all responses
dashboardApp.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

// --- GET /overview ---
dashboardApp.get('/overview', (c) => {
  try {
    return c.json(getOverviewStats());
  } catch (err) {
    logger.error({ err }, 'Dashboard overview error');
    return errorResponse(c, 500, 'DB_ERROR', 'Failed to load overview');
  }
});

// --- GET /chats ---
dashboardApp.get('/chats', (c) => {
  const channel = c.req.query('channel') || undefined;
  const search = c.req.query('search') || undefined;

  try {
    return c.json({ chats: getChatsWithCounts(channel, search) });
  } catch (err) {
    logger.error({ err }, 'Dashboard chats error');
    return errorResponse(c, 500, 'DB_ERROR', 'Failed to load chats');
  }
});

// --- GET /chats/:jid/messages ---
dashboardApp.get('/chats/:jid/messages', (c) => {
  const jid = c.req.param('jid');
  const before = c.req.query('before') || undefined;
  const limitStr = c.req.query('limit') || '50';
  const limit = Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 200);

  // Verify chat exists
  if (!stmts.chatExists.get(jid)) {
    return errorResponse(
      c,
      404,
      'CHAT_NOT_FOUND',
      `Chat ${jid} does not exist`,
    );
  }

  try {
    const rows = getMessageHistory(jid, limit, before);
    // Return in chronological order (DB returns DESC)
    const messages = rows.reverse().map((m) => ({
      id: m.id,
      senderName: m.sender_name,
      content: m.content,
      timestamp: m.timestamp,
      isBotMessage: m.is_bot_message === 1,
      threadTs: m.thread_ts ?? null,
    }));
    return c.json({ messages });
  } catch (err) {
    logger.error({ err }, 'Dashboard messages error');
    return errorResponse(c, 500, 'DB_ERROR', 'Failed to load messages');
  }
});

// --- GET /groups ---
dashboardApp.get('/groups', (c) => {
  try {
    const rows = stmts.allGroups.all() as GroupRow[];
    const groups = rows.map((r) => ({
      jid: r.jid,
      name: r.name,
      folder: r.folder,
      trigger: r.trigger_pattern,
      channel: deriveChannel(r.jid),
      addedAt: r.added_at,
      requiresTrigger:
        r.requires_trigger === null ? true : r.requires_trigger === 1,
    }));
    return c.json({ groups });
  } catch (err) {
    logger.error({ err }, 'Dashboard groups error');
    return errorResponse(c, 500, 'DB_ERROR', 'Failed to load groups');
  }
});

// --- GET /tasks ---
dashboardApp.get('/tasks', (c) => {
  try {
    const rows = stmts.allTasks.all() as TaskRow[];
    const tasks = rows.map((r) => ({
      id: r.id,
      groupFolder: r.group_folder,
      chatJid: r.chat_jid,
      prompt: r.prompt,
      scheduleType: r.schedule_type,
      scheduleValue: r.schedule_value,
      contextMode: r.context_mode,
      nextRun: r.next_run,
      lastRun: r.last_run,
      lastResult: r.last_result,
      status: r.status,
      createdAt: r.created_at,
    }));
    return c.json({ tasks });
  } catch (err) {
    logger.error({ err }, 'Dashboard tasks error');
    return errorResponse(c, 500, 'DB_ERROR', 'Failed to load tasks');
  }
});

// --- GET /tasks/:id/runs ---
dashboardApp.get('/tasks/:id/runs', (c) => {
  const taskId = c.req.param('id');
  const limitStr = c.req.query('limit') || '20';
  const limit = Math.min(Math.max(parseInt(limitStr, 10) || 20, 1), 100);

  if (!stmts.taskExists.get(taskId)) {
    return errorResponse(
      c,
      404,
      'TASK_NOT_FOUND',
      `Task ${taskId} does not exist`,
    );
  }

  try {
    const rows = stmts.taskRuns.all(taskId, limit) as TaskRunRow[];
    const runs = rows.map((r) => ({
      id: r.id,
      runAt: r.run_at,
      durationMs: r.duration_ms,
      status: r.status,
      result: r.result,
      error: r.error,
    }));
    return c.json({ runs });
  } catch (err) {
    logger.error({ err }, 'Dashboard task runs error');
    return errorResponse(c, 500, 'DB_ERROR', 'Failed to load task runs');
  }
});

// --- GET /events (SSE) ---
dashboardApp.get('/events', (c) => {
  if (sseConnectionCount >= MAX_SSE_CONNECTIONS) {
    return errorResponse(
      c,
      429,
      'TOO_MANY_CONNECTIONS',
      'Max SSE connections reached',
    );
  }

  return streamSSE(c, async (stream) => {
    sseConnectionCount++;
    try {
      let running = true;
      let lastMessageTs = new Date().toISOString();
      let lastRunTs = new Date().toISOString();

      stream.onAbort(() => {
        running = false;
      });

      while (running) {
        try {
          const newMessages = stmts.newMessagesSince.all(
            lastMessageTs,
          ) as MessageRow[];
          for (const msg of newMessages) {
            await stream.writeSSE({
              event: 'message',
              data: JSON.stringify({
                chatJid: msg.chat_jid,
                senderName: msg.sender_name,
                content: msg.content,
                timestamp: msg.timestamp,
                isBotMessage: msg.is_bot_message === 1,
              }),
              id: String(++globalEventId),
            });
            if (msg.timestamp > lastMessageTs) lastMessageTs = msg.timestamp;
          }

          const newRuns = stmts.newTaskRunsSince.all(
            lastRunTs,
          ) as TaskRunRow[];
          for (const run of newRuns) {
            await stream.writeSSE({
              event: 'taskRun',
              data: JSON.stringify({
                taskId: run.task_id,
                status: run.status,
                runAt: run.run_at,
                durationMs: run.duration_ms,
                error: run.error,
              }),
              id: String(++globalEventId),
            });
            if (run.run_at > lastRunTs) lastRunTs = run.run_at;
          }

          // Heartbeat if nothing new
          if (newMessages.length === 0 && newRuns.length === 0) {
            await stream.writeSSE({
              event: 'heartbeat',
              data: '',
              id: String(++globalEventId),
            });
          }
        } catch (err) {
          logger.error({ err }, 'SSE poll error');
        }

        await stream.sleep(3000);
      }
    } finally {
      sseConnectionCount--;
    }
  });
});
