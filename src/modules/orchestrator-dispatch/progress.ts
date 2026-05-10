import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { getTaskById } from './db/tasks.js';

export async function applySpawnProgress(content: Record<string, unknown>, callerSession: Session): Promise<void> {
  const taskId = content.task_id as string | undefined;
  const message = (content.message as string | undefined) ?? '';

  if (!taskId) {
    log.warn('applySpawnProgress: missing task_id — silently skipping', { sessionId: callerSession.id });
    return;
  }

  const task = getTaskById(taskId);
  if (!task) {
    log.warn('applySpawnProgress: task not found — silently skipping', { taskId });
    return;
  }

  // Two-column auth: task_id + child_session_id (fire-and-forget — auth mismatch logged, not thrown)
  if (task.child_session_id !== callerSession.id) {
    log.warn('applySpawnProgress: auth mismatch — silently skipping', {
      taskId,
      expected: task.child_session_id,
      got: callerSession.id,
    });
    return;
  }

  // Truncate to ≤500 chars
  const truncated = message.slice(0, 500);
  const now = new Date().toISOString();

  try {
    // Status guard — only update on active tasks. A late progress message on an
    // already-terminal task should not pollute timestamps post-dating cancelled_at /
    // completed_at / failed_at, which would break the lifecycle invariant.
    getDb()
      .prepare(
        `UPDATE tasks SET last_progress_at = ?, last_progress_message = ? WHERE task_id = ? AND status IN ('pending', 'running')`,
      )
      .run(now, truncated, taskId);
  } catch (err) {
    log.warn('applySpawnProgress: DB update failed — silently swallowing', { taskId, err });
  }
}
