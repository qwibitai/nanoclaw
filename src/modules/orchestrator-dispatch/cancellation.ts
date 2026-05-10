import { randomUUID } from 'crypto';

import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { killContainer } from '../../container-runner.js';
import type { Session } from '../../types.js';
import { getTaskById, transitionToTerminal } from './db/tasks.js';

export async function applyDispatchCancel(content: Record<string, unknown>, callerSession: Session): Promise<void> {
  const taskId = content.task_id as string | undefined;
  const reason = (content.reason as string | undefined) ?? 'cancelled';

  if (!taskId) {
    log.warn('applyDispatchCancel: missing task_id', { sessionId: callerSession.id });
    return;
  }

  const task = getTaskById(taskId);
  if (!task) {
    log.warn('applyDispatchCancel: task not found', { taskId });
    return;
  }

  // Auth: ONLY parent_session_id match — no isOwner OR-clause (cycle-1 M2 / C17)
  if (callerSession.id !== task.parent_session_id) {
    log.warn('applyDispatchCancel: auth failed — not the parent session', {
      taskId,
      expected: task.parent_session_id,
      got: callerSession.id,
    });
    return;
  }

  const now = new Date().toISOString();

  if (task.status === 'pending' || task.status === 'running') {
    const transitioned = transitionToTerminal(taskId, 'cancelled', {
      cancelled_at: now,
    });

    if (!transitioned) {
      log.debug('applyDispatchCancel: task already in terminal state', { taskId });
      return;
    }

    if (task.status === 'running' && task.child_session_id) {
      // Write _dispatch_cancel envelope to child's inbound (cycle-3 S26)
      const childSession = getSession(task.child_session_id);
      if (childSession) {
        try {
          await writeSessionMessage(childSession.agent_group_id, task.child_session_id, {
            id: randomUUID(),
            kind: 'system',
            timestamp: now,
            content: JSON.stringify({ _dispatch_cancel: { task_id: taskId, reason } }),
          });
        } catch (err) {
          log.warn('applyDispatchCancel: failed to write cancel envelope to child', { taskId, err });
        }
      }

      // Arm 2-minute hard kill timer
      const childSessionId = task.child_session_id;
      setTimeout(() => {
        log.info('applyDispatchCancel: 2-min grace expired, killing child container', { taskId, childSessionId });
        killContainer(childSessionId, `dispatch_cancel: ${reason}`);
      }, 120_000);
    }

    // Notify parent of successful cancellation
    const parentSession = getSession(task.parent_session_id);
    if (parentSession) {
      try {
        await writeSessionMessage(task.parent_agent_group_id, task.parent_session_id, {
          id: randomUUID(),
          kind: 'chat',
          timestamp: now,
          content: JSON.stringify({
            text: `Task cancelled: ${taskId}. Reason: ${reason}`,
            _task_update: { task_id: taskId, status: 'cancelled', reason },
          }),
        });
      } catch (err) {
        log.warn('applyDispatchCancel: failed to notify parent', { taskId, err });
      }
    }
  } else {
    log.debug('applyDispatchCancel: task in non-cancellable state', { taskId, status: task.status });
  }
}
