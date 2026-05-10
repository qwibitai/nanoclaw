/**
 * Outbound message delivery.
 * Polls session outbound DBs for undelivered messages, delivers through channel adapters.
 *
 * Two-DB architecture:
 *   - Reads messages_out from outbound.db (container-owned, opened read-only)
 *   - Tracks delivery in inbound.db's `delivered` table (host-owned)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import type Database from 'better-sqlite3';

import { getRunningSessions, getActiveSessions, createPendingQuestion } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroupByPlatform } from './db/messaging-groups.js';
import {
  getDueOutboundMessages,
  getDeliveredIds,
  markDelivered,
  markDeliveryFailed,
  migrateDeliveredTable,
} from './db/session-db.js';
import { log } from './log.js';
import { scrubSecrets } from './secret-scrubber.js';
import { upsertArchiveMessage } from './message-archive.js';
import { normalizeOptions } from './channels/ask-question.js';
import { clearOutbox, openInboundDb, openOutboundDb, readOutboxFiles } from './session-manager.js';
import { pauseTypingRefreshAfterDelivery, setTypingAdapter } from './modules/typing/index.js';
import type { OutboundFile } from './channels/adapter.js';
import type { Session } from './types.js';

const ACTIVE_POLL_MS = 1000;
const SWEEP_POLL_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 3;

/** Track delivery attempt counts. Resets on process restart (gives failed messages a fresh chance). */
const deliveryAttempts = new Map<string, number>();

/**
 * Per-session tracking of the currently-visible status line. First
 * `kind='status'` in a turn posts a fresh message and caches the route
 * + platform message id here; subsequent status events in the same turn
 * edit that message in place. On real chat delivery the orphan is
 * deleted via `deleteMessage` (using the *stored* route, not the chat
 * delivery's route — `send_message` can target a different
 * channel/thread than the session's status was posted to) and tracking
 * is cleared.
 */
interface StatusTrack {
  channelType: string;
  platformId: string;
  threadId: string | null;
  messageId: string;
}
const statusTracking = new Map<string, StatusTrack>();

/**
 * Sessions whose outbound queue is currently being drained.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages, and a running session
 * is in *both* result sets. Without this guard, the two timer chains can
 * race on the same outbound row: both read it as undelivered, both call
 * the channel adapter, both markDelivered (idempotent in the DB via
 * INSERT OR IGNORE — but the user has already seen the message twice).
 */
const inflightDeliveries = new Set<string>();

export interface ChannelDeliveryAdapter {
  deliver(
    channelType: string,
    platformId: string,
    threadId: string | null,
    kind: string,
    content: string,
    files?: OutboundFile[],
  ): Promise<string | undefined>;
  setTyping?(channelType: string, platformId: string, threadId: string | null): Promise<void>;
  deleteMessage?(channelType: string, platformId: string, threadId: string | null, messageId: string): Promise<void>;
  postParent?(channelType: string, platformId: string, text: string): Promise<{ messageId: string }>;
  createThread?(
    channelType: string,
    platformId: string,
    parentMessageId: string,
    title: string,
    firstMessage: string,
  ): Promise<{ threadId: string; messageId: string }>;
}

let deliveryAdapter: ChannelDeliveryAdapter | null = null;
let activePolling = false;
let sweepPolling = false;

/**
 * Callbacks fired when the delivery adapter is first set (and again if it's
 * replaced). Lets modules that need the adapter at boot (e.g. approvals →
 * OneCLI handler) hook in without core calling into the module directly.
 *
 * Not a general-purpose registry — narrow lifecycle hook only.
 */
type AdapterReadyCallback = (adapter: ChannelDeliveryAdapter) => void | Promise<void>;
const adapterReadyCallbacks: AdapterReadyCallback[] = [];

/**
 * Invariant guard: channel_type and platform_id must BOTH be null or BOTH be non-null.
 * A mix (one null, one set) indicates corrupted routing state and should fail loudly
 * before any adapter call or DB write that relies on this pair.
 */
export function assertChannelRoutingConsistency({
  channelType,
  platformId,
}: {
  channelType: string | null;
  platformId: string | null;
}): void {
  const isNull = (v: string | null | undefined): boolean => v === null || v === undefined || v === '';
  if (isNull(channelType) !== isNull(platformId)) {
    throw new Error(
      `inconsistent channel routing: channel_type and platform_id must both be null or both non-null. ` +
        `Got channelType=${JSON.stringify(channelType)}, platformId=${JSON.stringify(platformId)}`,
    );
  }
}

/** Current delivery adapter or null if not yet set. Modules use this in live
 *  message-flow handlers where the adapter is guaranteed to be set. For
 *  boot-time setup (before the adapter is ready), use onDeliveryAdapterReady. */
export function getDeliveryAdapter(): ChannelDeliveryAdapter | null {
  return deliveryAdapter;
}

export function onDeliveryAdapterReady(cb: AdapterReadyCallback): void {
  adapterReadyCallbacks.push(cb);
  if (deliveryAdapter) {
    // Already set — fire immediately so late registrations still run.
    void Promise.resolve()
      .then(() => cb(deliveryAdapter as ChannelDeliveryAdapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

export function setDeliveryAdapter(adapter: ChannelDeliveryAdapter): void {
  deliveryAdapter = adapter;
  // Forward to the typing module so it can fire setTyping on its own
  // interval. Direct call, not a registry — typing is a default module.
  setTypingAdapter(adapter);
  for (const cb of adapterReadyCallbacks) {
    void Promise.resolve()
      .then(() => cb(adapter))
      .catch((err) => log.error('onDeliveryAdapterReady callback threw', { err }));
  }
}

/** Start the active container poll loop (~1s). */
export function startActiveDeliveryPoll(): void {
  if (activePolling) return;
  activePolling = true;
  pollActive();
}

/** Start the sweep poll loop (~60s). */
export function startSweepDeliveryPoll(): void {
  if (sweepPolling) return;
  sweepPolling = true;
  pollSweep();
}

async function pollActive(): Promise<void> {
  if (!activePolling) return;

  try {
    const sessions = getRunningSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Active delivery poll error', { err });
  }

  setTimeout(pollActive, ACTIVE_POLL_MS);
}

async function pollSweep(): Promise<void> {
  if (!sweepPolling) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await deliverSessionMessages(session);
    }
  } catch (err) {
    log.error('Sweep delivery poll error', { err });
  }

  setTimeout(pollSweep, SWEEP_POLL_MS);
}

export async function deliverSessionMessages(session: Session): Promise<void> {
  // Reject re-entry from a concurrent poll on the same session — see the
  // comment on inflightDeliveries above.
  if (inflightDeliveries.has(session.id)) return;
  inflightDeliveries.add(session.id);

  try {
    await drainSession(session);
  } finally {
    inflightDeliveries.delete(session.id);
  }
}

async function drainSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  let outDb: Database.Database;
  let inDb: Database.Database;
  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return; // DBs might not exist yet
  }

  try {
    // Read all due messages from outbound.db (read-only)
    const allDue = getDueOutboundMessages(outDb);
    if (allDue.length === 0) return;

    // Filter out already-delivered messages using inbound.db's delivered table
    const delivered = getDeliveredIds(inDb);
    const undelivered = allDue.filter((m) => !delivered.has(m.id));
    if (undelivered.length === 0) return;

    // Ensure platform_message_id column exists (migration for existing sessions)
    migrateDeliveredTable(inDb);

    for (const msg of undelivered) {
      try {
        const result = await deliverMessage(msg, session, inDb);
        // System actions like request_bash_gate return deferAck:true — the
        // handler owns the `delivered` row lifecycle and writes it later
        // (on admin approval or timeout). Auto-acking here would race
        // ahead of the human and silently unblock a gated command.
        if (!result.deferAck) {
          markDelivered(inDb, msg.id, result.platformMsgId ?? null);
        }
        deliveryAttempts.delete(msg.id);

        // Pause the typing indicator after a real user-facing message
        // lands on the user's screen, so the client has time to visually
        // clear the indicator before the next heartbeat tick brings it
        // back. Skip the pause for internal traffic (system actions,
        // agent-to-agent routing) — the user doesn't see those and
        // shouldn't get a gap in their typing indicator for them.
        if (msg.kind !== 'system' && msg.channel_type !== 'agent') {
          pauseTypingRefreshAfterDelivery(session.id);
        }
      } catch (err) {
        const attempts = (deliveryAttempts.get(msg.id) ?? 0) + 1;
        deliveryAttempts.set(msg.id, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          log.error('Message delivery failed permanently, giving up', {
            messageId: msg.id,
            sessionId: session.id,
            attempts,
            err,
          });
          const errMsg = err instanceof Error ? err.message : String(err);
          markDeliveryFailed(inDb, msg.id, errMsg);
          deliveryAttempts.delete(msg.id);
        } else {
          log.warn('Message delivery failed, will retry', {
            messageId: msg.id,
            sessionId: session.id,
            attempt: attempts,
            maxAttempts: MAX_DELIVERY_ATTEMPTS,
            err,
          });
        }
      }
    }
  } finally {
    outDb.close();
    inDb.close();
  }
}

async function deliverMessage(
  msg: {
    id: string;
    kind: string;
    platform_id: string | null;
    channel_type: string | null;
    thread_id: string | null;
    content: string;
    in_reply_to: string | null;
  },
  session: Session,
  inDb: Database.Database,
): Promise<{ platformMsgId?: string; deferAck?: true }> {
  assertChannelRoutingConsistency({ channelType: msg.channel_type, platformId: msg.platform_id });

  if (!deliveryAdapter) {
    log.warn('No delivery adapter configured, dropping message', { id: msg.id });
    return {};
  }

  const content = JSON.parse(msg.content);

  // System actions — handle internally (schedule_task, cancel_task, etc.)
  if (msg.kind === 'system') {
    const result = await handleSystemAction(content, session, inDb);
    if (result && result.deferAck) return { deferAck: true };
    return {};
  }

  // Agent-to-agent — route to target session via the agent-to-agent module.
  // Guarded by the channel_type check. If the module isn't installed the
  // `agent_destinations` table won't exist and `routeAgentMessage`'s permission
  // check will throw, which falls into the normal retry → mark-failed path.
  if (msg.channel_type === 'agent') {
    if (!hasTable(getDb(), 'agent_destinations')) {
      throw new Error(`agent-to-agent module not installed — cannot route message ${msg.id}`);
    }
    const { routeAgentMessage } = await import('./modules/agent-to-agent/agent-route.js');
    await routeAgentMessage(msg, session);
    return {};
  }

  // Permission check: the source agent must be allowed to deliver to this
  // channel destination. Two ways it passes:
  //
  //   1. The target is the session's own origin chat (session.messaging_group_id
  //      matches). An agent can always reply to the chat it was spawned from;
  //      requiring a destinations row for the obvious case is a footgun.
  //
  //   2. Otherwise, the agent must have an explicit agent_destinations row
  //      targeting that messaging group. createMessagingGroupAgent() inserts
  //      these automatically when wiring, so an operator wiring additional
  //      chats to the agent doesn't need a separate ACL step.
  //
  // Failures throw — unlike a silent `return`, an Error falls into the retry
  // path in deliverSessionMessages and eventually marks the message as failed
  // (instead of marking it delivered when nothing was actually delivered,
  // which was the pre-refactor bug).
  if (msg.channel_type && msg.platform_id) {
    const mg = getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
    if (!mg) {
      throw new Error(`unknown messaging group for ${msg.channel_type}/${msg.platform_id} (message ${msg.id})`);
    }
    const isOriginChat = session.messaging_group_id === mg.id;
    // Guarded: without the agent-to-agent module, `agent_destinations`
    // doesn't exist and we permit all non-origin channel sends (the
    // origin-chat case is always allowed regardless). Inlined SQL instead
    // of importing `hasDestination` so core doesn't depend on the module.
    if (!isOriginChat && hasTable(getDb(), 'agent_destinations')) {
      const row = getDb()
        .prepare(
          'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
        )
        .get(session.agent_group_id, 'channel', mg.id);
      if (!row) {
        throw new Error(
          `unauthorized channel destination: ${session.agent_group_id} cannot send to ${mg.channel_type}/${mg.platform_id}`,
        );
      }
    }
  }

  // Status messages — post-then-edit per session. First status in a turn
  // posts a fresh line; subsequent statuses edit it in place. The tracking
  // clears when a real chat message delivers (handled at the end), so the
  // next turn starts with a new status line instead of clobbering history.
  if (msg.kind === 'status') {
    if (!msg.channel_type || !msg.platform_id) {
      log.warn('Status message missing routing fields, dropping', { id: msg.id });
      return {};
    }
    const existing = statusTracking.get(session.id);
    let outbound = scrubSecrets(msg.content);
    if (existing) {
      const parsed = JSON.parse(outbound);
      outbound = JSON.stringify({
        operation: 'edit',
        messageId: existing.messageId,
        text: parsed.text,
      });
    }
    const platformMsgId = await deliveryAdapter.deliver(
      msg.channel_type,
      msg.platform_id,
      msg.thread_id,
      msg.kind,
      outbound,
    );
    if (platformMsgId && !existing) {
      // Pin the route at post-time. The cleanup branch on chat delivery uses
      // *this* route to delete the orphan, NOT the chat-final's route — the
      // agent's send_message MCP tool can target a different channel/thread,
      // and using the wrong (channel, ts) pair on Slack's chat.delete could
      // delete an unrelated message if the timestamps happened to collide.
      statusTracking.set(session.id, {
        channelType: msg.channel_type,
        platformId: msg.platform_id,
        threadId: msg.thread_id,
        messageId: platformMsgId,
      });
    }
    log.info('Status delivered', {
      id: msg.id,
      sessionId: session.id,
      mode: existing ? 'edit' : 'post',
      platformMsgId: platformMsgId ?? existing?.messageId,
    });
    return { platformMsgId: platformMsgId ?? undefined };
  }

  // Track pending questions for ask_user_question flow.
  // Guarded: without the interactive module, `pending_questions` doesn't
  // exist and we skip persistence — the card still delivers to the user,
  // but the response path has nowhere to land and will log unclaimed.
  if (content.type === 'ask_question' && content.questionId && hasTable(getDb(), 'pending_questions')) {
    const title = content.title as string | undefined;
    const rawOptions = content.options as unknown;
    if (!title || !Array.isArray(rawOptions)) {
      log.error('ask_question missing required title/options — not persisting', {
        questionId: content.questionId,
      });
    } else {
      const inserted = createPendingQuestion({
        question_id: content.questionId,
        session_id: session.id,
        message_out_id: msg.id,
        platform_id: msg.platform_id,
        channel_type: msg.channel_type,
        thread_id: msg.thread_id,
        title,
        options: normalizeOptions(rawOptions as never),
        created_at: new Date().toISOString(),
      });
      if (inserted) {
        log.info('Pending question created', { questionId: content.questionId, sessionId: session.id });
      }
    }
  }

  // Channel delivery
  if (!msg.channel_type || !msg.platform_id) {
    log.warn('Message missing routing fields', { id: msg.id });
    return {};
  }

  // Read file attachments from outbox if the content declares files.
  // File I/O lives in session-manager.ts (symmetric with inbound
  // extractAttachmentFiles) — delivery just hands buffers to the adapter.
  const files =
    Array.isArray(content.files) && content.files.length > 0
      ? readOutboxFiles(session.agent_group_id, session.id, msg.id, content.files as string[])
      : undefined;

  // Scrub any registered secret values out of outbound text before it
  // reaches the adapter. Defense-in-depth — OneCLI already keeps API keys
  // away from the agent, but scrub content anyway in case an agent ever
  // ends up with a secret (e.g. by reading a file) and tries to echo it.
  const scrubbedContent = scrubSecrets(msg.content);

  // Final chat replies always post fresh (not as an edit of the in-flight
  // status bubble). When a user follow-up message arrives during the turn,
  // morphing the status into the answer would land the answer above the
  // follow-up in the thread — visually confusing. Status updates still
  // post-then-edit on their own (kind='status' branch above), so the
  // thinking bubble remains a single growing message; only the final
  // answer separates out into its own message at the bottom.

  const platformMsgId = await deliveryAdapter.deliver(
    msg.channel_type,
    msg.platform_id,
    msg.thread_id,
    msg.kind,
    scrubbedContent,
    files,
  );
  log.info('Message delivered', {
    id: msg.id,
    channelType: msg.channel_type,
    platformId: msg.platform_id,
    platformMsgId,
    fileCount: files?.length,
  });

  // A real chat message supersedes any in-flight progress status. Delete
  // the orphan thinking-block message so it doesn't linger in the thread,
  // then clear the tracking entry. Uses the *stored* route (pinned when
  // the status was first posted) — `send_message` can deliver this chat
  // reply to a different channel/thread than the status was posted to,
  // and using the chat reply's route to call `chat.delete` would target
  // the wrong channel.
  //
  // Errors are swallowed: a delete failure (network, permission revoked,
  // message already gone) leaves the orphan visible but must NOT block
  // markDelivered for the chat reply itself — that would cause retry/
  // duplicate of the real answer.
  if (msg.kind === 'chat') {
    const orphan = statusTracking.get(session.id);
    if (orphan && deliveryAdapter.deleteMessage) {
      try {
        await deliveryAdapter.deleteMessage(orphan.channelType, orphan.platformId, orphan.threadId, orphan.messageId);
      } catch (err) {
        log.warn('Failed to delete orphan thinking-block status — leaving as-is', {
          sessionId: session.id,
          channelType: orphan.channelType,
          platformId: orphan.platformId,
          messageId: orphan.messageId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    statusTracking.delete(session.id);

    // Mirror agent replies into the central archive (2.9). Scrubbed text
    // so any accidentally-included secret stays out of searchable history.
    try {
      const parsed = JSON.parse(scrubbedContent) as Record<string, unknown>;
      const text =
        typeof parsed.text === 'string' ? parsed.text : typeof parsed.content === 'string' ? parsed.content : '';
      if (text && msg.channel_type && msg.platform_id) {
        const mg = getMessagingGroupByPlatform(msg.channel_type, msg.platform_id);
        upsertArchiveMessage({
          id: msg.id,
          agentGroupId: session.agent_group_id,
          messagingGroupId: session.messaging_group_id,
          channelType: msg.channel_type,
          channelName: mg?.name ?? null,
          platformId: msg.platform_id,
          threadId: msg.thread_id,
          role: 'assistant',
          senderId: session.agent_group_id,
          senderName: 'assistant',
          text,
          sentAt: new Date().toISOString(),
        });
      }
    } catch {
      // best-effort
    }
  }

  clearOutbox(session.agent_group_id, session.id, msg.id);

  return { platformMsgId: platformMsgId ?? undefined };
}

/**
 * Delivery action registry.
 *
 * Modules register handlers for system-kind outbound message actions via
 * `registerDeliveryAction`. Core checks the registry first in
 * `handleSystemAction` and falls through to the inline switch when no
 * handler is registered. The switch will shrink as modules are extracted
 * (scheduling, approvals, agent-to-agent) and eventually only its default
 * branch remains.
 *
 * Default when no handler registered and the switch doesn't match: log
 * "Unknown system action" and return.
 */
/**
 * Return value for a system-action delivery handler.
 *
 * - `undefined` / `void` — default: the outer delivery loop marks the
 *   message as delivered in inbound.db after the handler returns.
 * - `{ deferAck: true }` — handler takes ownership of the `delivered` row
 *   for this message. The outer loop must NOT call markDelivered — the
 *   handler will mark delivered/failed itself later (e.g. after an async
 *   admin approval). Required for bash-gate: the gate's requestId IS the
 *   msg.id, and the container polls `delivered` for that id as its ack
 *   signal, so a premature auto-ack would short-circuit the gate.
 */
export type DeliveryActionResult = void | { deferAck: true };
export type DeliveryActionHandler = (
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
) => Promise<DeliveryActionResult>;

const actionHandlers = new Map<string, DeliveryActionHandler>();

export function registerDeliveryAction(action: string, handler: DeliveryActionHandler): void {
  if (actionHandlers.has(action)) {
    log.warn('Delivery action handler overwritten', { action });
  }
  actionHandlers.set(action, handler);
}

/**
 * Handle system actions from the container agent.
 * These are written to messages_out because the container can't write to inbound.db.
 * The host applies them to inbound.db here.
 */
async function handleSystemAction(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<DeliveryActionResult> {
  const action = content.action as string;
  log.info('System action from agent', { sessionId: session.id, action });

  const registered = actionHandlers.get(action);
  if (registered) {
    return registered(content, session, inDb);
  }

  log.warn('Unknown system action', { action });
  return undefined;
}

export function stopDeliveryPolls(): void {
  activePolling = false;
  sweepPolling = false;
}
