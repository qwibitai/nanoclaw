import { randomUUID } from 'crypto';
import fs from 'fs';

import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb, resolveSession, writeSessionMessage } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';
import type { Session } from '../../types.js';
import {
  CapabilityConfig,
  getCapabilityConfig,
  hasOrchestratorCapability,
} from './db/agent-group-capabilities.js';
import {
  Task,
  acquireCompletionLease,
  countActiveByParent,
  getTaskById,
  incrementCompletionAttempts,
  insertTaskAtomic,
  transitionToTerminal,
  updateArtifactColumn,
  getTaskByParentAndIdempotency,
} from './db/tasks.js';
import { computeRequestHash, deriveDispatchTaskId } from './derive-task-id.js';

const DEFAULT_CAPABILITY_CONFIG: CapabilityConfig = {
  concurrencyCap: 5,
  noProgressTimeoutSec: 1800,
  spawnDeadlineSec: 300,
  drainGraceSec: 120,
};

/** In-process deduplication guard for completeDispatchSideEffects. */
const completionInFlight = new Map<string, Promise<void>>();

export async function applyDispatchTask(
  content: Record<string, unknown>,
  callerSession: Session,
): Promise<void> {
  const idempotencyKey = content.idempotency_key as string | undefined;
  const targetGroupRaw = content.target_group as string | undefined;
  const taskContent = content.content as string | undefined;
  const deadline = (content.deadline as string | null | undefined) ?? null;

  if (!idempotencyKey || !targetGroupRaw || !taskContent) {
    await _notifyCaller(callerSession, 'dispatch rejected: missing required fields (target_group, content, idempotency_key)');
    return;
  }

  // Step 1: Auth — caller's agent_group must have orchestrator capability
  if (!hasOrchestratorCapability(callerSession.agent_group_id)) {
    await _notifyCaller(callerSession, 'dispatch rejected: not an orchestrator');
    return;
  }

  // Resolve target_group: agents typically pass folder/name (e.g. 'illysium'),
  // not the opaque id ('ag_*'). Try id first, then folder, then name.
  // Per QA Codex finding E4 (target_group accepts only IDs).
  const targetGroup = _resolveAgentGroupId(targetGroupRaw);
  if (!targetGroup) {
    await _notifyCaller(callerSession, `dispatch rejected: target agent group not found: ${targetGroupRaw}`);
    return;
  }

  const capConfig = getCapabilityConfig(callerSession.agent_group_id, 'orchestrator') ?? DEFAULT_CAPABILITY_CONFIG;

  // All 8 admission steps inside a single better-sqlite3 transaction.
  // Use IMMEDIATE (write lock from BEGIN) instead of DEFERRED (default) so the
  // cap-count read holds the write lock through the INSERT — prevents two parallel
  // delivery drains from different orchestrator sessions both reading the same
  // count, both passing the cap check, and both succeeding INSERT (per-target-group
  // cap exceeded). Cycle-3 S3-C / Concurrency-reviewer #5.
  const db = getDb();
  let taskRow: Task | null = null;
  let replayResult: { message: string } | null = null;

  db.transaction(() => {
    // Step 2: Idempotency replay PRECEDES cap (cycle-3 M20)
    const existingByIdempotency = getTaskByParentAndIdempotency(callerSession.id, idempotencyKey);
    if (existingByIdempotency) {
      const computedHash = computeRequestHash(targetGroup, taskContent, deadline);
      if (existingByIdempotency.request_hash !== computedHash) {
        replayResult = { message: `idempotency_key_reused_with_different_payload: key=${idempotencyKey}` };
        return;
      }
      replayResult = { message: `Task already exists: task_id=${existingByIdempotency.task_id} status=${existingByIdempotency.status}` };
      return;
    }

    // Step 3: Concurrency cap — only for NEW admissions
    const activeCount = countActiveByParent(callerSession.id);
    if (activeCount >= capConfig.concurrencyCap) {
      replayResult = { message: `dispatch rejected: concurrency cap reached (${activeCount}/${capConfig.concurrencyCap})` };
      return;
    }

    // Step 4: Target validation
    if (targetGroup === callerSession.agent_group_id) {
      replayResult = { message: 'dispatch rejected: cannot dispatch to own agent group' };
      return;
    }
    const targetExists = db.prepare('SELECT 1 FROM agent_groups WHERE id = ? LIMIT 1').get(targetGroup);
    if (!targetExists) {
      replayResult = { message: `dispatch rejected: target agent group not found: ${targetGroup}` };
      return;
    }
    if (hasOrchestratorCapability(targetGroup)) {
      replayResult = { message: 'dispatch rejected: cannot dispatch to another orchestrator (no orchestrator-targeting orchestrators in v1)' };
      return;
    }

    // Step 5: Wiring check
    if (callerSession.messaging_group_id !== null) {
      const wired = db
        .prepare(
          'SELECT 1 FROM messaging_group_agents WHERE agent_group_id = ? AND messaging_group_id = ? LIMIT 1',
        )
        .get(targetGroup, callerSession.messaging_group_id);
      if (!wired) {
        replayResult = { message: 'dispatch rejected: target_not_wired_to_caller_messaging_group' };
        return;
      }
    }

    // Step 6: Compute request_hash
    const requestHash = computeRequestHash(targetGroup, taskContent, deadline);

    // Step 7: Determine surface_mode — per-channel capability check (cycle-3 S24)
    let surfaceMode: 'native_thread' | 'headless' = 'headless';
    if (callerSession.messaging_group_id !== null) {
      const mg = getMessagingGroup(callerSession.messaging_group_id);
      if (mg) {
        const adapter = getChannelAdapter(mg.channel_type);
        if (adapter && typeof adapter.createThread === 'function') {
          surfaceMode = 'native_thread';
        }
      }
    }

    // Step 8: Atomic INSERT
    const taskId = deriveDispatchTaskId(callerSession.id, idempotencyKey);
    const now = new Date().toISOString();
    taskRow = insertTaskAtomic({
      task_id: taskId,
      idempotency_key: idempotencyKey,
      parent_session_id: callerSession.id,
      parent_agent_group_id: callerSession.agent_group_id,
      parent_messaging_group_id: callerSession.messaging_group_id,
      target_agent_group_id: targetGroup,
      child_session_id: null,
      status: 'pending',
      task_content: taskContent,
      request_hash: requestHash,
      deadline,
      parent_platform_message_id: null,
      child_platform_thread_id: null,
      child_messaging_group_id: null,
      admitted_at: now,
      started_at: null,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      last_progress_at: null,
      last_progress_message: null,
      fail_reason: null,
      result_summary: null,
      dispatch_completion_attempts: 0,
      completion_lease_at: null,
      surface_mode: surfaceMode,
    });

    // Parallel admit race: if INSERT returned null, SELECT the winner
    if (taskRow === null) {
      taskRow = getTaskByParentAndIdempotency(callerSession.id, idempotencyKey);
      if (taskRow) {
        replayResult = { message: `Task already exists (parallel admit): task_id=${taskRow.task_id} status=${taskRow.status}` };
        taskRow = null;
      }
    }
  }).immediate();

  // Post-transaction handling
  // TypeScript doesn't track mutation through the transaction callback,
  // so we assert the type here.
  const postTxnReplay = replayResult as { message: string } | null;
  if (postTxnReplay) {
    await _notifyCaller(callerSession, postTxnReplay.message);
    // P11 carry-forward: wake caller so it sees the notification on next turn
    void wakeContainer(callerSession).catch((err) =>
      log.warn('wakeContainer(caller) failed after replay notification', { err }),
    );
    return;
  }

  const finalTaskRow = taskRow as Task | null;
  if (!finalTaskRow) {
    log.warn('applyDispatchTask: no task row after transaction (unexpected)', { callerSessionId: callerSession.id });
    return;
  }

  const admittedTask = finalTaskRow;

  // Sync admit notification — failure logged but NOT thrown
  await _notifyCaller(callerSession, `Task admitted: ${admittedTask.task_id}`);

  // P11 carry-forward: wake caller so it sees the admit notification
  void wakeContainer(callerSession).catch((err) =>
    log.warn('wakeContainer(caller) failed after admit notification', { err }),
  );

  // Schedule side-effect completion
  setImmediate(completeDispatchSideEffects, admittedTask.task_id);
}

/**
 * Post-admit side-effect completion: postParent → createThread → openSession.
 * Called via setImmediate from applyDispatchTask AND from the reconciler for crash recovery.
 */
export async function completeDispatchSideEffects(taskId: string): Promise<void> {
  // In-process deduplication guard
  const existing = completionInFlight.get(taskId);
  if (existing) {
    return existing;
  }

  const promise = _runCompletionSideEffects(taskId).catch((err) => {
    log.warn('completeDispatchSideEffects: unhandled error', { taskId, err });
  });
  completionInFlight.set(taskId, promise);
  promise.finally(() => {
    completionInFlight.delete(taskId);
  });
  return promise;
}

async function _runCompletionSideEffects(taskId: string): Promise<void> {
  // Acquire durable lease — returns null if another worker holds it
  const leaseRow = acquireCompletionLease(taskId);
  if (!leaseRow) {
    log.debug('completeDispatchSideEffects: lease held by another worker, skipping', { taskId });
    return;
  }

  const releaseLeaseAndFinish = () => {
    try {
      getDb()
        .prepare(`UPDATE tasks SET completion_lease_at = NULL WHERE task_id = ?`)
        .run(taskId);
    } catch (err) {
      log.warn('completeDispatchSideEffects: failed to release lease', { taskId, err });
    }
  };

  try {
    const task = getTaskById(taskId);
    if (!task || task.status !== 'pending') {
      return;
    }

    if (task.surface_mode === 'native_thread') {
      await _runThreadedPath(task);
    } else {
      await _runHeadlessPath(task);
    }
  } catch (err) {
    log.warn('completeDispatchSideEffects: error during completion', { taskId, err });
    const attempts = incrementCompletionAttempts(taskId);
    if (attempts >= 5) {
      transitionToTerminal(taskId, 'failed', {
        fail_reason: 'completion_exhausted',
        failed_at: new Date().toISOString(),
      });
      log.warn('completeDispatchSideEffects: task marked completion_exhausted', { taskId, attempts });
    }
  } finally {
    releaseLeaseAndFinish();
  }
}

async function _runThreadedPath(task: Task): Promise<void> {
  const taskId = task.task_id;

  // Resolve adapter — if adapter no longer has createThread, mark failed immediately
  // (adapter_unavailable does NOT consume retry budget — cycle-3 fix / Codex #43)
  const mg = task.parent_messaging_group_id
    ? getMessagingGroup(task.parent_messaging_group_id)
    : undefined;
  if (!mg) {
    transitionToTerminal(taskId, 'failed', {
      fail_reason: 'adapter_unavailable',
      failed_at: new Date().toISOString(),
    });
    return;
  }

  const adapter = getChannelAdapter(mg.channel_type);
  if (!adapter || typeof adapter.createThread !== 'function') {
    transitionToTerminal(taskId, 'failed', {
      fail_reason: 'adapter_unavailable',
      failed_at: new Date().toISOString(),
    });
    return;
  }

  // Step 1: postParent
  {
    const current = getTaskById(taskId);
    if (!current || current.status !== 'pending') return;

    if (current.parent_platform_message_id === null) {
      const truncContent = task.task_content.slice(0, 100);
      // Per-adapter signature: postParent(platformId, text) — no channelType prefix
      const { messageId } = await adapter.postParent!(mg.platform_id, `Launched dispatch: ${truncContent}`);
      const updated = updateArtifactColumn(taskId, 'parent_platform_message_id', messageId);
      if (!updated) return; // status-CAS rejected — another path won
    }
  }

  // Step 2: createThread
  {
    const current = getTaskById(taskId);
    if (!current || current.status !== 'pending') return;

    if (current.child_platform_thread_id === null) {
      const parentMsgId = current.parent_platform_message_id!;
      // Per-adapter signature: createThread(platformId, parentMsgId, title, first)
      const { threadId } = await adapter.createThread!(
        mg.platform_id,
        parentMsgId,
        `Task: ${task.task_content.slice(0, 80)}`,
        task.task_content,
      );
      // Slack: threadId IS parent_platform_message_id (cycle-3 M25)
      const childMgId = task.parent_messaging_group_id;
      const updated = updateArtifactColumn(taskId, 'child_platform_thread_id', threadId);
      if (!updated) return;
      if (childMgId) {
        updateArtifactColumn(taskId, 'child_messaging_group_id', childMgId);
      }
    }
  }

  // Step 3: openSession (cycle-3 M21 write order)
  {
    const current = getTaskById(taskId);
    if (!current || current.status !== 'pending') return;

    if (current.child_session_id === null) {
      const { session: childSession } = resolveSession(
        task.target_agent_group_id,
        task.parent_messaging_group_id,
        current.child_platform_thread_id!,
        'per-thread',
      );

      // a. UPDATE tasks first (cycle-3 M21)
      const now = new Date().toISOString();
      const updated = getDb()
        .prepare(
          `UPDATE tasks SET child_session_id = ?, started_at = ?, last_progress_at = ?, status = 'running'
             WHERE task_id = ? AND status = 'pending' AND child_session_id IS NULL`,
        )
        .run(childSession.id, now, now, taskId);
      if (updated.changes === 0) return;

      // b. Write dispatch_task_id to child's inbound.db session_routing
      _writeDispatchTaskIdToRouting(childSession.agent_group_id, childSession.id, taskId);

      // c. Write first inbound to child
      await writeSessionMessage(childSession.agent_group_id, childSession.id, {
        id: randomUUID(),
        kind: 'chat',
        timestamp: now,
        content: JSON.stringify({ _dispatch: { task_id: taskId }, text: task.task_content }),
      });

      // d. Wake child LAST (cycle-3 M21)
      void wakeContainer(childSession).catch((err) =>
        log.warn('wakeContainer(child) failed in threaded path', { taskId, err }),
      );

      // Notify parent with thread URL
      const parentSession = _resolveParentSession(task);
      if (parentSession) {
        const threadUrl = `Thread started: ${current.child_platform_thread_id}`;
        await _notifyParent(task, threadUrl);
        void wakeContainer(parentSession).catch((err) =>
          log.warn('wakeContainer(parent) failed after threaded completion', { taskId, err }),
        );
      }
    }
  }
}

async function _runHeadlessPath(task: Task): Promise<void> {
  const taskId = task.task_id;

  const current = getTaskById(taskId);
  if (!current || current.status !== 'pending') return;

  if (current.child_session_id === null) {
    const { session: childSession } = resolveSession(
      task.target_agent_group_id,
      null,
      taskId, // synthetic thread_id = task_id (C4 safe: mgId=null → no adapter.deliver)
      'per-thread',
    );

    // a. UPDATE tasks first (cycle-3 M21)
    const now = new Date().toISOString();
    const updated = getDb()
      .prepare(
        `UPDATE tasks SET child_session_id = ?, started_at = ?, last_progress_at = ?, status = 'running'
           WHERE task_id = ? AND status = 'pending' AND child_session_id IS NULL`,
      )
      .run(childSession.id, now, now, taskId);
    if (updated.changes === 0) return;

    // b. Write dispatch_task_id to child's inbound.db session_routing
    _writeDispatchTaskIdToRouting(childSession.agent_group_id, childSession.id, taskId);

    // c. Write first inbound
    await writeSessionMessage(childSession.agent_group_id, childSession.id, {
      id: randomUUID(),
      kind: 'chat',
      timestamp: now,
      content: JSON.stringify({ _dispatch: { task_id: taskId }, text: task.task_content }),
    });

    // d. Wake child LAST
    void wakeContainer(childSession).catch((err) =>
      log.warn('wakeContainer(child) failed in headless path', { taskId, err }),
    );

    // Notify parent (no platform URL in headless mode)
    await _notifyParent(task, `Headless task running: ${taskId}`);
    const parentSession = _resolveParentSession(task);
    if (parentSession) {
      void wakeContainer(parentSession).catch((err) =>
        log.warn('wakeContainer(parent) failed after headless completion', { taskId, err }),
      );
    }
  }
}

function _writeDispatchTaskIdToRouting(agentGroupId: string, sessionId: string, taskId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    db.prepare(
      `INSERT INTO session_routing (id, dispatch_task_id)
       VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET dispatch_task_id = excluded.dispatch_task_id`,
    ).run(taskId);
  } finally {
    db.close();
  }
}

function _resolveParentSession(task: Task): Session | null {
  const session = getSession(task.parent_session_id);
  return session ?? null;
}

/**
 * Resolve a target agent group identifier to a canonical id.
 *
 * Agents typically know groups by folder name (e.g. 'illysium'), not the opaque
 * `ag_*` id. The MCP tool schema doesn't enforce id-only, and orchestrators are
 * far more likely to pass folder/name. Resolution order: id → folder → name.
 * Returns null if no match found in any column.
 *
 * Per QA Codex finding E4 — admit-time validation must accept either id or
 * folder/name to be useful in practice.
 */
function _resolveAgentGroupId(targetGroupRaw: string): string | null {
  const db = getDb();
  // Try canonical id first (cheapest, most specific)
  const byId = db.prepare('SELECT id FROM agent_groups WHERE id = ? LIMIT 1').get(targetGroupRaw) as
    | { id: string }
    | undefined;
  if (byId) return byId.id;
  // Then folder (UNIQUE per migration 001)
  const byFolder = db
    .prepare('SELECT id FROM agent_groups WHERE folder = ? LIMIT 1')
    .get(targetGroupRaw) as { id: string } | undefined;
  if (byFolder) return byFolder.id;
  // Then human-facing name (not unique — return first match if any)
  const byName = db
    .prepare('SELECT id FROM agent_groups WHERE name = ? LIMIT 1')
    .get(targetGroupRaw) as { id: string } | undefined;
  if (byName) return byName.id;
  return null;
}

async function _notifyCaller(session: Session, message: string): Promise<void> {
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: randomUUID(),
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ text: message }),
    });
  } catch (err) {
    log.warn('applyDispatchTask: failed to notify caller', { sessionId: session.id, err });
  }
}

async function _notifyParent(task: Task, message: string): Promise<void> {
  try {
    const parentSession = getSession(task.parent_session_id);
    if (!parentSession) return;
    await writeSessionMessage(task.parent_agent_group_id, task.parent_session_id, {
      id: randomUUID(),
      kind: 'chat',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({ text: message }),
    });
  } catch (err) {
    log.warn('completeDispatchSideEffects: failed to notify parent', { taskId: task.task_id, err });
  }
}
