/**
 * Steer write path — POST /dashboard/api/tasks/:id/message.
 *
 * Implements design §4 cycle-3 revised: input validation, §2a scope check,
 * member-role guard, rate-limit (30/min per user:session), reserve-before-write
 * idempotency (B4), partial-write recovery, SSE emit, wakeContainer, and
 * fire-and-forget echo via setImmediate.
 */
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';

import { getDb } from '../db/connection.js';
import { getSession } from '../db/sessions.js';
import { log } from '../log.js';
import { writeSessionMessage } from '../session-manager.js';
import { sessionInboundHasMessage } from '../db/session-db.js';
import { wakeContainer } from '../container-runner.js';
import { getChannelAdapter } from '../channels/channel-registry.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from '../modules/permissions/db/user-roles.js';
import { isMember } from '../modules/permissions/db/agent-group-members.js';
import {
  reserveIdempotency,
  applyIdempotency,
  claimEchoAttempted,
  IdempotencyConflict,
} from './db/steer-idempotency.js';
import { emitDashboardEvent } from './api/events.js';
import type { AuthHandler, AuthedRequestContext } from './router.js';

// ── In-memory rate-limit: keyed by `${user_id}:${child_session_id}` ──────────

interface RateWindow {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateWindow>();
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Opportunistic eviction threshold for rate-limit Map. The map is in-memory and
// per-(user, child_session) — entries accumulate over time as new sessions are
// created. Without eviction the map grows unbounded over the host's lifetime
// (post-build QA fix SF-7). When size crosses this threshold we sweep stale
// entries (those whose windows have fully expired). Threshold chosen well above
// realistic concurrent session count to keep the sweep cost amortized.
const RATE_LIMIT_MAP_SOFT_CAP = 1024;

function _sweepExpiredRateWindows(now: number): void {
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(key);
    }
  }
}

function checkRateLimit(key: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  if (rateLimitMap.size > RATE_LIMIT_MAP_SOFT_CAP) {
    _sweepExpiredRateWindows(now);
  }
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }
  entry.count++;
  return { allowed: true };
}

function refundRateLimit(key: string): void {
  const entry = rateLimitMap.get(key);
  if (entry && entry.count > 0) entry.count--;
}

export function _resetRateLimitForTesting(): void {
  rateLimitMap.clear();
}

// ── Role check ────────────────────────────────────────────────────────────────

function canSteer(userId: string, agentGroupId: string): { ok: boolean; reason?: string } {
  if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
    return { ok: true };
  }
  if (isMember(userId, agentGroupId)) {
    return { ok: false, reason: 'member_role_cannot_steer' };
  }
  return { ok: false, reason: 'task_not_found' };
}

// ── applySteer ────────────────────────────────────────────────────────────────

export async function applySteer(
  taskId: string,
  body: { idempotency_key: string; text: string },
  ctx: AuthedRequestContext,
): Promise<{ status: 202 | 400 | 403 | 404 | 409 | 422 | 429 | 503; body: Record<string, unknown> }> {
  const userId = ctx.user.id;
  const text = body.text;
  const idempotencyKey = body.idempotency_key;

  // C7 input validation
  if (!text || !text.trim()) {
    return { status: 400, body: { error: 'empty_message' } };
  }
  if (text.length > 4000) {
    return { status: 400, body: { error: 'message_too_long' } };
  }

  // Load task
  const task = getDb().prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as
    | {
        task_id: string;
        parent_agent_group_id: string;
        child_session_id: string | null;
        surface_mode: string;
        child_messaging_group_id: string | null;
        child_platform_thread_id: string | null;
        status: string;
      }
    | undefined;

  // §2a scope check — disclose-as-not-found
  if (!task) {
    return { status: 404, body: { error: 'task_not_found' } };
  }

  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(task.parent_agent_group_id)) {
    return { status: 404, body: { error: 'task_not_found' } };
  }

  // C2 member-role check. Disclose-as-not-found per §2a (post-build QA fix SF-2):
  // returning 403 here would confirm task existence to members and enable enumeration.
  const roleCheck = canSteer(userId, task.parent_agent_group_id);
  if (!roleCheck.ok) {
    return { status: 404, body: { error: 'task_not_found' } };
  }

  // No child session → 409
  if (!task.child_session_id) {
    return { status: 409, body: { error: 'task_has_no_child_session' } };
  }

  const childSessionId = task.child_session_id;
  const rateLimitKey = `${userId}:${childSessionId}`;

  // Rate limit
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    return { status: 429, body: { error: 'rate_limit_exceeded', retry_after: rateCheck.retryAfter } };
  }

  // Idempotency reservation
  const trimmedText = text.trim();
  const requestHash = createHash('sha256').update(trimmedText).digest('hex');
  const messageId = randomUUID();

  let reserved: ReturnType<typeof reserveIdempotency>;
  try {
    reserved = reserveIdempotency(userId, idempotencyKey, taskId, messageId, trimmedText, requestHash);
  } catch (err) {
    if (err instanceof IdempotencyConflict) {
      refundRateLimit(rateLimitKey);
      return {
        status: 422,
        body: {
          error: 'mismatched_idempotency_payload',
          conflict_kind: err.conflictKind,
        },
      };
    }
    throw err;
  }

  // Replay with applied cached response
  if (reserved.status === 'applied' && reserved.cached) {
    return { status: 202, body: reserved.cached as unknown as Record<string, unknown> };
  }

  const resolvedMessageId = reserved.messageId;
  const childSession = getSession(childSessionId);
  if (!childSession) {
    refundRateLimit(rateLimitKey);
    return { status: 404, body: { error: 'task_not_found' } };
  }

  // Partial-write recovery: check if inbound write already happened
  const inboundExists = sessionInboundHasMessage(childSession.agent_group_id, childSessionId, resolvedMessageId);

  if (!inboundExists) {
    const now = new Date().toISOString();
    try {
      await writeSessionMessage(childSession.agent_group_id, childSessionId, {
        id: resolvedMessageId,
        kind: 'chat',
        timestamp: now,
        content: JSON.stringify({
          text: trimmedText,
          _via: 'dashboard',
          _steer: { task_id: taskId, user_id: userId },
        }),
        trigger: 1,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
        // Concurrent retry race (PK on id, UNIQUE on seq) — treat as success
      } else if (code === 'SQLITE_BUSY') {
        refundRateLimit(rateLimitKey);
        return { status: 503, body: { error: 'db_busy', retry_after: 2 } };
      } else {
        refundRateLimit(rateLimitKey);
        throw err;
      }
    }
  }

  // Emit SSE after inbound write commits
  try {
    emitDashboardEvent('inbound_message', {
      task_id: taskId,
      child_session_id: childSessionId,
      parent_agent_group_id: task.parent_agent_group_id,
      message_id: resolvedMessageId,
    });
  } catch {
    // non-fatal
  }

  // Wake container
  void wakeContainer(childSession).catch((err) =>
    log.warn('steer: wakeContainer failed', { taskId, err }),
  );

  const steerResponse = {
    task_id: taskId,
    message_id: resolvedMessageId,
    echo_status: 'pending',
  };

  // Apply idempotency AFTER successful inbound write
  applyIdempotency(userId, idempotencyKey, steerResponse);

  // Fire-and-forget echo via setImmediate (C3 — 202 returns before echo settles).
  // Atomic CAS via claimEchoAttempted prevents the echo-duplication race where two
  // concurrent retries with the same idempotency_key both see echo_attempted=0 at
  // reservation time and both schedule adapter.deliver. Post-build QA fix SF-1.
  if (claimEchoAttempted(reserved.id)) {
    setImmediate(async () => {
      try {
        await _fireEchoAsync(taskId, task.parent_agent_group_id, task, childSessionId, trimmedText, ctx);
      } catch {
        // outer catch covers sync throws — claim already committed; nothing to roll back
      }
    });
  }

  return { status: 202, body: steerResponse };
}

async function _fireEchoAsync(
  taskId: string,
  agentGroupId: string,
  task: {
    surface_mode: string;
    child_messaging_group_id: string | null;
    child_platform_thread_id: string | null;
  },
  _childSessionId: string,
  text: string,
  ctx: AuthedRequestContext,
): Promise<void> {
  if (task.surface_mode !== 'native_thread' || !task.child_platform_thread_id) {
    await _emitEchoStatus('skipped_headless', taskId, agentGroupId);
    return;
  }

  const mgId = task.child_messaging_group_id;
  if (!mgId) {
    await _emitEchoStatus('adapter_unavailable', taskId, agentGroupId);
    return;
  }

  const mg = getMessagingGroup(mgId);
  if (!mg) {
    await _emitEchoStatus('adapter_unavailable', taskId, agentGroupId);
    return;
  }

  const adapter = getChannelAdapter(mg.channel_type);
  if (!adapter || typeof adapter.deliver !== 'function') {
    await _emitEchoStatus('adapter_unavailable', taskId, agentGroupId);
    return;
  }

  const displayName = ctx.user.display_name ?? ctx.user.id;
  try {
    await adapter.deliver(mg.platform_id, task.child_platform_thread_id, {
      kind: 'chat',
      content: { text: `[via dashboard] ${text} — ${displayName}` },
    });
    await _emitEchoStatus('echoed', taskId, agentGroupId);
  } catch {
    await _emitEchoStatus('echo_failed', taskId, agentGroupId);
  }
}

async function _emitEchoStatus(
  echoStatus: 'echoed' | 'echo_failed' | 'adapter_unavailable' | 'skipped_headless',
  taskId: string,
  agentGroupId: string,
): Promise<void> {
  log.debug('steer: echo_status', { echoStatus });
  emitDashboardEvent('task_event', {
    task_id: taskId,
    kind: 'progress',
    agent_group_id: agentGroupId,
    echo_status: echoStatus,
  });
}

export const steerHandler: AuthHandler = async (req, params, ctx) => {
  let body: { idempotency_key?: string; text?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!body.idempotency_key) {
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const taskId = params['id'] ?? '';
  const result = await applySteer(taskId, { idempotency_key: body.idempotency_key, text: body.text ?? '' }, ctx);

  const statusMap: Record<number, number> = { 202: 202, 400: 400, 403: 403, 404: 404, 409: 409, 422: 422, 429: 429, 503: 503 };
  const httpStatus = statusMap[result.status] ?? 500;

  return new Response(JSON.stringify(result.body), {
    status: httpStatus,
    headers: { 'Content-Type': 'application/json' },
  });
};
