/**
 * POST /dashboard/api/tasks/:id/retry — re-spawn a failed task with the
 * original brief and a fresh idempotency key.
 *
 * The retry runs the standard `applySpawnTask` admission path under the
 * authority of the original task's parent (orchestrator) session — same
 * scope checks, same concurrency cap, same surface_mode resolution. From
 * the orchestrator's perspective it looks like a new spawn it dispatched;
 * the dashboard is the originator.
 *
 * Disclose-as-not-found §2a applies — a user without scope on the parent
 * agent group sees 404, not 403.
 */
import { randomUUID } from 'crypto';

import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { applySpawnTask } from '../../modules/orchestrator-dispatch/dispatch.js';
import type { AuthHandler } from '../router.js';

interface FailedTaskRow {
  task_id: string;
  status: string;
  parent_session_id: string;
  parent_agent_group_id: string;
  task_content: string;
  fail_reason: string | null;
}

export const retryHandler: AuthHandler = async (_req, params, ctx) => {
  const taskId = params['id'] ?? '';

  let task: FailedTaskRow | null;
  try {
    task = getDb()
      .prepare(
        `SELECT task_id, status, parent_session_id, parent_agent_group_id, task_content, fail_reason
         FROM tasks WHERE task_id = ?`,
      )
      .get(taskId) as FailedTaskRow | null;
  } catch (err) {
    log.warn('retryHandler: DB error', { taskId, err: err instanceof Error ? err.message : String(err) });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!task) {
    return new Response(JSON.stringify({ error: 'task_not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // §2a scope filter — disclose-as-not-found (not 403)
  if (!ctx.scopes.no_filter) {
    if (!ctx.scopes.allowed_group_ids.includes(task.parent_agent_group_id)) {
      return new Response(JSON.stringify({ error: 'task_not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  // Only failed/cancelled tasks are eligible for retry. A running task
  // shouldn't be cloned; a completed task is already done. The frontend
  // gates this on the failed lane, but enforce server-side too.
  if (task.status !== 'failed' && task.status !== 'cancelled') {
    return new Response(
      JSON.stringify({
        error: 'task_not_retryable',
        message: `Task is in status '${task.status}' — only failed/cancelled tasks can be retried.`,
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const parentSession = getSession(task.parent_session_id);
  if (!parentSession) {
    return new Response(
      JSON.stringify({
        error: 'parent_session_missing',
        message: 'The orchestrator session that admitted the original task no longer exists.',
      }),
      { status: 410, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Fresh idempotency key — must differ from the original or applySpawnTask
  // returns the existing failed task instead of admitting a new one. The
  // prefix preserves the lineage for debug/audit grep.
  const idempotencyKey = `dashboard-retry-${task.task_id}-${randomUUID().slice(0, 8)}`;

  try {
    await applySpawnTask(
      {
        idempotency_key: idempotencyKey,
        content: task.task_content,
      },
      parentSession,
    );
  } catch (err) {
    log.warn('retryHandler: applySpawnTask threw', {
      originalTaskId: task.task_id,
      err: err instanceof Error ? err.message : String(err),
    });
    return new Response(JSON.stringify({ error: 'spawn_failed', message: 'Could not admit the retry task.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({
      status: 'admitted',
      original_task_id: task.task_id,
      idempotency_key: idempotencyKey,
    }),
    { status: 202, headers: { 'Content-Type': 'application/json' } },
  );
};
