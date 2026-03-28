import { getDb } from './db.js';
import { logger } from './logger.js';
import { ScheduledTask } from './types.js';

export type TaskLifecycleState = 'born' | 'active' | 'stalled' | 'dying' | 'dead' | 'fossilized';

export const LIFECYCLE_THRESHOLDS = {
  stalledAfterMs: 7 * 24 * 60 * 60 * 1000,
  dyingAfterMs: 14 * 24 * 60 * 60 * 1000,
  deadAfterMs: 21 * 24 * 60 * 60 * 1000,
} as const;

export interface TaskFossil {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  original_status: string;
  lifecycle_state: TaskLifecycleState;
  context_snapshot: Record<string, unknown> | null;
  fossilized_at: string;
  created_at: string;
}

let lifecycleMonitorRunning = false;

export function advanceTaskLifecycle(taskId: string, now?: Date): TaskLifecycleState | null {
  const db = getDb();
  const task = db
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(taskId) as (ScheduledTask & { lifecycle_state: TaskLifecycleState }) | undefined;

  if (!task) {
    return null;
  }

  if (task.status === 'paused' || task.status === 'completed') {
    return null;
  }

  const nowMs = (now ?? new Date()).getTime();
  const currentState = task.lifecycle_state ?? 'born';

  let nextState: TaskLifecycleState | null = null;

  if (currentState === 'born') {
    if (task.last_run !== null) {
      nextState = 'active';
    }
  } else if (currentState === 'active') {
    if (task.last_run !== null) {
      const lastRunMs = new Date(task.last_run).getTime();
      if (nowMs - lastRunMs > LIFECYCLE_THRESHOLDS.stalledAfterMs) {
        nextState = 'stalled';
      }
    }
  } else if (currentState === 'stalled') {
    if (task.last_run !== null) {
      const lastRunMs = new Date(task.last_run).getTime();
      if (nowMs - lastRunMs > LIFECYCLE_THRESHOLDS.dyingAfterMs) {
        nextState = 'dying';
      }
    }
  } else if (currentState === 'dying') {
    if (task.last_run !== null) {
      const lastRunMs = new Date(task.last_run).getTime();
      if (nowMs - lastRunMs > LIFECYCLE_THRESHOLDS.deadAfterMs) {
        nextState = 'dead';
      }
    }
  }

  if (nextState === null) {
    return null;
  }

  db.prepare('UPDATE scheduled_tasks SET lifecycle_state = ? WHERE id = ?').run(nextState, taskId);

  logger.info({ taskId, from: currentState, to: nextState }, 'Task lifecycle advanced');

  return nextState;
}

export function fossilizeTask(taskId: string): void {
  const db = getDb();
  const task = db
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(taskId) as (ScheduledTask & { lifecycle_state: TaskLifecycleState }) | undefined;

  if (!task) {
    logger.warn({ taskId }, 'fossilizeTask: task not found');
    return;
  }

  const runCountRow = db
    .prepare('SELECT COUNT(*) as cnt FROM task_run_logs WHERE task_id = ?')
    .get(taskId) as { cnt: number };
  const runCount = runCountRow.cnt;

  const contextSnapshot = JSON.stringify({
    last_result: task.last_result,
    last_run: task.last_run,
    run_count: runCount,
  });

  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO task_fossils (id, group_folder, chat_jid, prompt, original_status, lifecycle_state, context_snapshot, fossilized_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.status,
    task.lifecycle_state ?? 'dead',
    contextSnapshot,
    now,
    task.created_at,
  );

  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(taskId);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(taskId);

  logger.info({ taskId, group_folder: task.group_folder }, 'Task fossilized');
}

export function getTaskFossil(id: string): TaskFossil | undefined {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM task_fossils WHERE id = ?')
    .get(id) as (Omit<TaskFossil, 'context_snapshot'> & { context_snapshot: string | null }) | undefined;

  if (!row) return undefined;

  return {
    ...row,
    context_snapshot: row.context_snapshot ? JSON.parse(row.context_snapshot) : null,
  };
}

export function getTaskFossils(groupFolder: string): TaskFossil[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM task_fossils WHERE group_folder = ? ORDER BY fossilized_at DESC')
    .all(groupFolder) as (Omit<TaskFossil, 'context_snapshot'> & { context_snapshot: string | null })[];

  return rows.map((row) => ({
    ...row,
    context_snapshot: row.context_snapshot ? JSON.parse(row.context_snapshot) : null,
  }));
}

export function startLifecycleMonitorLoop(options?: { pollIntervalMs?: number }): void {
  if (lifecycleMonitorRunning) {
    logger.debug('Lifecycle monitor already running, skipping');
    return;
  }

  lifecycleMonitorRunning = true;
  const pollIntervalMs = options?.pollIntervalMs ?? 3600000;

  logger.info({ pollIntervalMs }, 'Starting task lifecycle monitor loop');

  const tick = () => {
    if (!lifecycleMonitorRunning) return;

    try {
      const db = getDb();
      const tasks = db
        .prepare("SELECT * FROM scheduled_tasks WHERE status = 'active'")
        .all() as (ScheduledTask & { lifecycle_state: TaskLifecycleState })[];

      for (const task of tasks) {
        try {
          const newState = advanceTaskLifecycle(task.id);
          if (newState === 'dead') {
            fossilizeTask(task.id);
          }
        } catch (err) {
          logger.error({ taskId: task.id, err }, 'Error advancing task lifecycle');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in lifecycle monitor tick');
    }

    if (lifecycleMonitorRunning) {
      setTimeout(tick, pollIntervalMs);
    }
  };

  setTimeout(tick, pollIntervalMs);
}

export function _resetLifecycleMonitorForTests(): void {
  lifecycleMonitorRunning = false;
}
