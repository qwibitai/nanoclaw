/**
 * ThagomizerClaw — Cloudflare Workers Entry Point
 *
 * Handles:
 *   1. Inbound webhooks from Telegram, Discord, Slack
 *   2. Queue consumers (async agent execution)
 *   3. Cron triggers (scheduled tasks + cleanup)
 *   4. Admin HTTP API (group management, task scheduling)
 *
 * Security model:
 *   - All secrets injected via Cloudflare Secrets (never in code)
 *   - Webhook signatures verified before processing
 *   - Rate limiting via RateLimiterDO
 *   - Admin endpoints require WEBHOOK_SECRET authentication
 *
 * Architecture:
 *   Webhook → D1 (store message) → Queue (async) → Agent (Claude API) → Channel API (send reply)
 */

import type { Env, NewMessage, RegisteredGroup, QueueMessage } from './types.js';
import { GroupSessionDO, RateLimiterDO } from './durable-objects/GroupSession.js';
import {
  storeChatMetadata,
  storeMessage,
  getAllRegisteredGroups,
  getMessagesSince,
  getDueTasks,
  updateTaskAfterRun,
  logTaskRun,
  setSession,
} from './db.js';
import {
  getGroupClaudeMd,
  getGlobalClaudeMd,
  getCursor,
  setCursor,
  getSessionId,
  setSessionId,
  writeAgentLog,
} from './storage.js';
import { formatMessages, shouldProcess, formatOutbound } from './router.js';
import { runAgent } from './agent.js';
import {
  verifyTelegramWebhook,
  parseTelegramWebhook,
  sendTelegramMessage,
  sendTelegramTyping,
  parseTelegramJid,
  ownsTelegramJid,
} from './channels/telegram.js';
import {
  verifyDiscordSignature,
  parseDiscordInteraction,
  sendDiscordMessage,
  parseDiscordChannelFromJid,
  ownsDiscordJid,
} from './channels/discord.js';
import {
  verifySlackSignature,
  parseSlackEvent,
  sendSlackMessage,
  parseSlackChannelFromJid,
  ownsSlackJid,
} from './channels/slack.js';

export { GroupSessionDO, RateLimiterDO };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function unauthorized(message = 'Unauthorized'): Response {
  return new Response(message, { status: 401 });
}

function badRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requireAuth(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization');
  return auth === `Bearer ${env.WEBHOOK_SECRET}`;
}

async function sendMessage(jid: string, text: string, env: Env): Promise<void> {
  const formatted = formatOutbound(text);
  if (!formatted) return;

  if (ownsTelegramJid(jid)) {
    const chatId = parseTelegramJid(jid);
    if (chatId) await sendTelegramMessage(chatId, formatted, env);
  } else if (ownsDiscordJid(jid)) {
    const channelId = parseDiscordChannelFromJid(jid);
    if (channelId) await sendDiscordMessage(channelId, formatted, env);
  } else if (ownsSlackJid(jid)) {
    const channelId = parseSlackChannelFromJid(jid);
    if (channelId) await sendSlackMessage(channelId, formatted, env);
  }
}

// ─── Message Processing ────────────────────────────────────────────────────────

async function processMessages(
  chatJid: string,
  group: RegisteredGroup,
  env: Env,
): Promise<void> {
  const assistantName = env.ASSISTANT_NAME ?? 'Andy';
  const cursor = await getCursor(env.STATE, chatJid);

  const messages = await getMessagesSince(env.DB, chatJid, cursor, assistantName);
  if (messages.length === 0) return;

  if (!shouldProcess(messages, group, assistantName)) return;

  // Advance cursor before agent runs (prevents double-processing on retry)
  const newCursor = messages[messages.length - 1].timestamp;
  await setCursor(env.STATE, chatJid, newCursor);

  // Load group memory (CLAUDE.md) from R2
  const claudeMd =
    (await getGroupClaudeMd(env.STORAGE, group.folder)) ??
    (group.isMain ? await getGlobalClaudeMd(env.STORAGE) : null) ??
    undefined;

  // Get session from KV (fast) then DB (authoritative)
  const sessionId =
    (await getSessionId(env.STATE, group.folder)) ??
    undefined;

  const prompt = formatMessages(messages, 'UTC');

  const startTime = Date.now();
  const result = await runAgent(
    {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid,
      isMain: group.isMain ?? false,
      assistantName,
      claudeMd,
      agentConfig: group.agentConfig,
    },
    env,
  );

  const durationMs = Date.now() - startTime;

  // Persist new session ID
  if (result.newSessionId) {
    await setSessionId(env.STATE, group.folder, result.newSessionId);
    await setSession(env.DB, group.folder, result.newSessionId);
  }

  // Write audit log
  await writeAgentLog(env.STORAGE, group.folder, {
    timestamp: new Date().toISOString(),
    group: group.name,
    isMain: group.isMain ?? false,
    durationMs,
    status: result.status,
    promptLength: prompt.length,
    model: result.model,
    error: result.error,
  });

  // Send response
  if (result.status === 'success' && result.result) {
    await sendMessage(chatJid, result.result, env);
  } else if (result.status === 'error') {
    // Rollback cursor on error so messages will be retried
    await setCursor(env.STATE, chatJid, cursor);
  }
}

// ─── Webhook Handlers ──────────────────────────────────────────────────────────

async function handleTelegramWebhook(
  request: Request,
  pathSecret: string,
  env: Env,
): Promise<Response> {
  if (!verifyTelegramWebhook(pathSecret, env)) {
    return unauthorized();
  }

  const update = await request.json();
  const event = parseTelegramWebhook(update as Parameters<typeof parseTelegramWebhook>[0]);
  if (!event) {
    return json({ ok: true }); // Unknown update type, ignore
  }

  const { chatJid, message } = event;

  // Store message
  await storeChatMetadata(env.DB, chatJid, message.timestamp, undefined, 'telegram', true);
  await storeMessage(env.DB, message, env.ASSISTANT_NAME ?? 'Andy');

  // Check if this group is registered
  const groups = await getAllRegisteredGroups(env.DB);
  const group = groups[chatJid];

  if (group) {
    // Send typing indicator
    const chatId = parseTelegramJid(chatJid);
    if (chatId) {
      await sendTelegramTyping(chatId, env).catch(() => {});
    }

    // Enqueue for async processing
    await env.MESSAGE_QUEUE.send({
      type: 'inbound_message',
      chatJid,
      messages: [message],
      timestamp: message.timestamp,
    });
  }

  return json({ ok: true });
}

async function handleDiscordWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.text();

  if (!(await verifyDiscordSignature(request, body, env))) {
    return unauthorized('Invalid Discord signature');
  }

  const interaction = JSON.parse(body);

  // Handle PING (Discord requires a PONG response)
  if (interaction.type === 1) {
    return json({ type: 1 });
  }

  const event = parseDiscordInteraction(interaction);
  if (!event) {
    return json({ type: 4, data: { content: 'Unknown interaction type' } });
  }

  const { chatJid, message } = event;

  await storeChatMetadata(env.DB, chatJid, message.timestamp, undefined, 'discord', true);
  await storeMessage(env.DB, message, env.ASSISTANT_NAME ?? 'Andy');

  const groups = await getAllRegisteredGroups(env.DB);
  const group = groups[chatJid];

  if (group) {
    await env.MESSAGE_QUEUE.send({
      type: 'inbound_message',
      chatJid,
      messages: [message],
      timestamp: message.timestamp,
    });
  }

  // Acknowledge interaction immediately (Discord requires <3s response)
  return json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
}

async function handleSlackWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.text();

  if (!(await verifySlackSignature(request, body, env))) {
    return unauthorized('Invalid Slack signature');
  }

  const event = JSON.parse(body) as Parameters<typeof parseSlackEvent>[0];

  // Handle URL verification challenge
  if (event.type === 'url_verification' && event.challenge) {
    return new Response(event.challenge, {
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const parsed = parseSlackEvent(event, event.team_id ?? '');
  if (!parsed) return json({ ok: true });

  const { chatJid, message } = parsed;

  await storeChatMetadata(env.DB, chatJid, message.timestamp, undefined, 'slack', true);
  await storeMessage(env.DB, message, env.ASSISTANT_NAME ?? 'Andy');

  const groups = await getAllRegisteredGroups(env.DB);
  const group = groups[chatJid];

  if (group) {
    await env.MESSAGE_QUEUE.send({
      type: 'inbound_message',
      chatJid,
      messages: [message],
      timestamp: message.timestamp,
    });
  }

  return json({ ok: true });
}

// ─── Admin API ────────────────────────────────────────────────────────────────

async function handleAdminRequest(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  if (!requireAuth(request, env)) {
    return unauthorized();
  }

  const action = url.pathname.replace('/admin/', '');

  if (action === 'groups' && request.method === 'GET') {
    const groups = await getAllRegisteredGroups(env.DB);
    return json(groups);
  }

  if (action === 'groups' && request.method === 'POST') {
    const { jid, group } = (await request.json()) as { jid: string; group: RegisteredGroup };
    const { setRegisteredGroup } = await import('./db.js');
    await setRegisteredGroup(env.DB, jid, group);
    return json({ ok: true });
  }

  if (action === 'tasks' && request.method === 'GET') {
    const { getAllTasks } = await import('./db.js');
    const tasks = await getAllTasks(env.DB);
    return json(tasks);
  }

  if (action === 'send' && request.method === 'POST') {
    const { jid, text } = (await request.json()) as { jid: string; text: string };
    await sendMessage(jid, text, env);
    return json({ ok: true });
  }

  if (action === 'health') {
    const [dbResult] = await Promise.allSettled([
      env.DB.prepare('SELECT 1').first(),
    ]);
    return json({
      status: 'ok',
      db: dbResult.status === 'fulfilled' ? 'ok' : 'error',
      assistant: env.ASSISTANT_NAME,
      environment: env.ENVIRONMENT,
      timestamp: new Date().toISOString(),
    });
  }

  return new Response('Not found', { status: 404 });
}

// ─── Queue Consumer ───────────────────────────────────────────────────────────

async function handleQueueMessage(
  message: Message<QueueMessage>,
  env: Env,
): Promise<void> {
  const job = message.body;

  if (job.type === 'inbound_message') {
    const groups = await getAllRegisteredGroups(env.DB);
    const group = groups[job.chatJid];
    if (!group) {
      message.ack();
      return;
    }

    try {
      await processMessages(job.chatJid, group, env);
      message.ack();
    } catch (err) {
      // Will be retried by Cloudflare (up to max_retries in wrangler.toml)
      message.retry();
    }
  } else if (job.type === 'scheduled_task') {
    try {
      const groups = await getAllRegisteredGroups(env.DB);
      const group = groups[job.chatJid];
      if (!group) {
        message.ack();
        return;
      }

      const claudeMd = await getGroupClaudeMd(env.STORAGE, group.folder);
      const sessionId = await getSessionId(env.STATE, group.folder);
      const startTime = Date.now();

      const result = await runAgent(
        {
          prompt: job.prompt,
          sessionId: sessionId ?? undefined,
          groupFolder: job.groupFolder,
          chatJid: job.chatJid,
          isMain: group.isMain ?? false,
          isScheduledTask: true,
          assistantName: env.ASSISTANT_NAME ?? 'Andy',
          claudeMd: claudeMd ?? undefined,
        },
        env,
      );

      const durationMs = Date.now() - startTime;

      await logTaskRun(env.DB, {
        task_id: job.taskId,
        run_at: new Date().toISOString(),
        duration_ms: durationMs,
        status: result.status,
        result: result.result,
        error: result.error ?? null,
      });

      if (result.status === 'success' && result.result) {
        await sendMessage(job.chatJid, result.result, env);
      }

      message.ack();
    } catch {
      message.retry();
    }
  }
}

// ─── Cron Handler ─────────────────────────────────────────────────────────────

async function handleCron(event: ScheduledEvent, env: Env): Promise<void> {
  const cron = event.cron;

  // Every minute: check for due scheduled tasks
  if (cron === '* * * * *') {
    const dueTasks = await getDueTasks(env.DB);

    for (const task of dueTasks) {
      await env.MESSAGE_QUEUE.send({
        type: 'scheduled_task',
        taskId: task.id,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        prompt: task.prompt,
      });

      // Calculate next run based on schedule type
      let nextRun: string | null = null;
      if (task.schedule_type === 'interval') {
        const intervalMs = parseInt(task.schedule_value, 10);
        nextRun = new Date(Date.now() + intervalMs).toISOString();
      } else if (task.schedule_type === 'cron') {
        nextRun = calculateNextCronRun(task.schedule_value);
      }
      // 'once' tasks get nextRun = null (marked completed)

      await updateTaskAfterRun(env.DB, task.id, nextRun, 'queued');
    }
  }

  // Every 5 minutes: cleanup
  if (cron === '*/5 * * * *') {
    // Future: cleanup expired logs, orphaned sessions, etc.
  }
}

function calculateNextCronRun(cronExpr: string): string {
  // Simplified next-run calculation — for production, use a proper cron parser
  // The worker environment supports cron-parser if bundled
  const now = new Date();
  // Default: next minute
  const next = new Date(now.getTime() + 60 * 1000);
  return next.toISOString();
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Health check (no auth required)
    if (pathname === '/' || pathname === '/health') {
      return json({ name: 'thagomizer_claw', status: 'ok', version: '1.0.0' });
    }

    // Webhook routes
    if (pathname.startsWith('/webhook/telegram/')) {
      const pathSecret = pathname.replace('/webhook/telegram/', '');
      return handleTelegramWebhook(request, pathSecret, env);
    }

    if (pathname === '/webhook/discord') {
      return handleDiscordWebhook(request, env);
    }

    if (pathname === '/webhook/slack') {
      return handleSlackWebhook(request, env);
    }

    // Admin API (requires Bearer WEBHOOK_SECRET)
    if (pathname.startsWith('/admin/')) {
      return handleAdminRequest(request, url, env);
    }

    return new Response('Not found', { status: 404 });
  },

  async queue(
    batch: MessageBatch<QueueMessage>,
    env: Env,
  ): Promise<void> {
    for (const message of batch.messages) {
      await handleQueueMessage(message, env);
    }
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(handleCron(event, env));
  },
} satisfies ExportedHandler<Env>;
