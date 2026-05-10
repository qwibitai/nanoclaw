import { randomUUID } from 'crypto';

import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { wakeContainer } from '../../container-runner.js';
import type { Session } from '../../types.js';
import { getTaskById, transitionToTerminal } from './db/tasks.js';

export async function applySpawnComplete(content: Record<string, unknown>, callerSession: Session): Promise<void> {
  const taskId = content.task_id as string | undefined;
  const summary = (content.summary as string | undefined) ?? '';

  if (!taskId) {
    log.warn('applySpawnComplete: missing task_id', { sessionId: callerSession.id });
    return;
  }

  const task = getTaskById(taskId);
  if (!task) {
    log.warn('applySpawnComplete: task not found', { taskId });
    return;
  }

  // Two-column auth: task_id + child_session_id must match caller
  if (task.child_session_id !== callerSession.id) {
    log.warn('applySpawnComplete: auth failed — child_session_id mismatch', {
      taskId,
      expected: task.child_session_id,
      got: callerSession.id,
    });
    return;
  }

  const now = new Date().toISOString();
  const transitioned = transitionToTerminal(taskId, 'completed', {
    completed_at: now,
    result_summary: summary,
  });

  // CAS returned false → already in terminal state; skip duplicate parent notification
  if (!transitioned) {
    log.debug('applySpawnComplete: task already in terminal state, skipping notify', { taskId });
    return;
  }

  // Notify parent
  const parentSession = getSession(task.parent_session_id);
  if (!parentSession) return;

  try {
    await writeSessionMessage(task.parent_agent_group_id, task.parent_session_id, {
      id: randomUUID(),
      kind: 'chat',
      timestamp: now,
      content: JSON.stringify({
        text: `Task completed: ${taskId}. Summary: ${summary}`,
        _task_update: { task_id: taskId, status: 'completed', result_summary: summary },
      }),
    });
    void wakeContainer(parentSession).catch((err) =>
      log.warn('applySpawnComplete: wakeContainer(parent) failed', { taskId, err }),
    );
  } catch (err) {
    log.warn('applySpawnComplete: failed to notify parent', { taskId, err });
  }
}

export async function applySpawnFailed(content: Record<string, unknown>, callerSession: Session): Promise<void> {
  const taskId = content.task_id as string | undefined;
  const summary = (content.summary as string | undefined) ?? '';
  const failReason = (content.fail_reason as string | undefined) ?? 'agent_error';

  if (!taskId) {
    log.warn('applySpawnFailed: missing task_id', { sessionId: callerSession.id });
    return;
  }

  const task = getTaskById(taskId);
  if (!task) {
    log.warn('applySpawnFailed: task not found', { taskId });
    return;
  }

  // Two-column auth: task_id + child_session_id must match caller
  if (task.child_session_id !== callerSession.id) {
    log.warn('applySpawnFailed: auth failed — child_session_id mismatch', {
      taskId,
      expected: task.child_session_id,
      got: callerSession.id,
    });
    return;
  }

  const now = new Date().toISOString();
  const transitioned = transitionToTerminal(taskId, 'failed', {
    failed_at: now,
    result_summary: summary,
    fail_reason: failReason,
  });

  if (!transitioned) {
    log.debug('applySpawnFailed: task already in terminal state, skipping notify', { taskId });
    return;
  }

  const parentSession = getSession(task.parent_session_id);
  if (!parentSession) return;

  try {
    await writeSessionMessage(task.parent_agent_group_id, task.parent_session_id, {
      id: randomUUID(),
      kind: 'chat',
      timestamp: now,
      content: JSON.stringify({
        text: `Task failed: ${taskId}. Reason: ${failReason}. Summary: ${summary}`,
        _task_update: {
          task_id: taskId,
          status: 'failed',
          fail_reason: failReason,
          result_summary: summary,
        },
      }),
    });
    void wakeContainer(parentSession).catch((err) =>
      log.warn('applySpawnFailed: wakeContainer(parent) failed', { taskId, err }),
    );
  } catch (err) {
    log.warn('applySpawnFailed: failed to notify parent', { taskId, err });
  }
}
