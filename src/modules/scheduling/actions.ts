/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change here.
 *
 * Tasks belong to the channel-root session, not the calling thread session.
 * The `inDb` argument that delivery.ts passes is the **calling session's**
 * inbound.db; we ignore it and open the channel-root session's inbound.db
 * instead (resolved via `resolveActiveSession`). Without this, an agent that
 * schedules from a Slack thread would have its task buried in that thread's
 * inbound.db — invisible to other threads, dead if the thread session is
 * archived. See sessions.ts:62-72 for the load-bearing rationale.
 *
 * Error notifications (`notifySchedulingFailure`, the "no live task matched"
 * notify in handleUpdateTask) still write to the **calling** session, since
 * that's where the agent's chat reply needs to surface.
 *
 * SECURITY (post-2026-05-02 cross-tenant leak): the host MUST NOT trust
 * agent-supplied routing fields (`platformId`/`channelType`/`threadId`) on
 * the system action. A compromised agent or a future MCP-tool bug can stamp
 * an arbitrary tenant's channel and the host would happily route the recap
 * there. The session is the authority — derive routing from
 * `session.messaging_group_id` and post to the channel root (`thread_id=null`)
 * regardless of what the container sent. Tasks scheduled in a session with no
 * messaging_group_id are rejected.
 */
import type Database from 'better-sqlite3';

import { wakeContainer } from '../../container-runner.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { resolveActiveSession } from '../../db/scheduled-tasks.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { openInboundDb, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { cancelTask, insertTask, pauseTask, resumeTask, updateTask, type TaskUpdate } from './db.js';

/**
 * Open the channel-root session's inbound.db for a (agent_group_id,
 * messaging_group_id) pair, run the operation, and close. Open-per-call is
 * required: the host invariant is one writer per file, opens-and-closes per
 * operation so cross-mount caches in any running container see the new rows
 * (see session-manager.ts:1-12).
 */
async function withChannelInbound<T>(
  agentGroupId: string,
  messagingGroupId: string,
  fn: (inDb: Database.Database) => T,
): Promise<T> {
  const channel = await resolveActiveSession(agentGroupId, messagingGroupId);
  const db = openInboundDb(agentGroupId, channel.id);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function notifySchedulingFailure(session: Session, message: string): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text: message, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) =>
      log.error('Failed to wake container after scheduling failure notification', { err }),
    );
  }
}

export async function handleScheduleTask(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = content.script as string | null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  // Authoritative routing comes from the session — NOT from agent-supplied
  // content. Reject schedules from sessions without a wired messaging group
  // (e.g., internal/background sessions); those have no chat surface to
  // deliver into and silently using session-routing fallback re-introduces
  // the cross-tenant leak class.
  if (!session.messaging_group_id) {
    log.warn('handleScheduleTask: rejected — session has no messaging_group_id', {
      taskId,
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
    });
    await notifySchedulingFailure(
      session,
      `schedule_task failed: this session has no chat destination wired. Schedule from a wired chat session.`,
    );
    return;
  }
  const mg = getMessagingGroup(session.messaging_group_id);
  if (!mg) {
    log.error('handleScheduleTask: session.messaging_group_id references missing MG', {
      taskId,
      messagingGroupId: session.messaging_group_id,
    });
    await notifySchedulingFailure(session, `schedule_task failed: messaging group not found.`);
    return;
  }

  await withChannelInbound(session.agent_group_id, session.messaging_group_id, (channelInDb) => {
    insertTask(channelInDb, {
      id: taskId,
      processAfter,
      recurrence,
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId: null,
      content: JSON.stringify({ prompt, script }),
    });
  });
  log.info('Scheduled task created', {
    taskId,
    processAfter,
    recurrence,
    platformId: mg.platform_id,
    channelType: mg.channel_type,
    callingSessionId: session.id,
  });
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  if (!session.messaging_group_id) {
    log.warn('handleCancelTask: rejected — session has no messaging_group_id', { taskId, sessionId: session.id });
    return;
  }
  await withChannelInbound(session.agent_group_id, session.messaging_group_id, (channelInDb) => {
    cancelTask(channelInDb, taskId);
  });
  log.info('Task cancelled', { taskId });
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  if (!session.messaging_group_id) {
    log.warn('handlePauseTask: rejected — session has no messaging_group_id', { taskId, sessionId: session.id });
    return;
  }
  await withChannelInbound(session.agent_group_id, session.messaging_group_id, (channelInDb) => {
    pauseTask(channelInDb, taskId);
  });
  log.info('Task paused', { taskId });
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  if (!session.messaging_group_id) {
    log.warn('handleResumeTask: rejected — session has no messaging_group_id', { taskId, sessionId: session.id });
    return;
  }
  await withChannelInbound(session.agent_group_id, session.messaging_group_id, (channelInDb) => {
    resumeTask(channelInDb, taskId);
  });
  log.info('Task resumed', { taskId });
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  if (!session.messaging_group_id) {
    log.warn('handleUpdateTask: rejected — session has no messaging_group_id', { taskId, sessionId: session.id });
    return;
  }
  const update: TaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }
  const touched = await withChannelInbound(session.agent_group_id, session.messaging_group_id, (channelInDb) =>
    updateTask(channelInDb, taskId, update),
  );
  log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
  if (touched === 0) {
    // Notify the agent that update_task matched nothing. Replicates the
    // old notifyAgent helper that used to live in delivery.ts — inlined
    // here so scheduling doesn't depend on delivery's private helpers.
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `update_task: no live task matched id "${taskId}".`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) =>
        log.error('Failed to wake container after update_task notification', { err }),
      );
    }
  }
}
