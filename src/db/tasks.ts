import Database from 'better-sqlite3';

import { ScheduledTask, TaskRunLog, TaskRunResult } from '../types.js';

let db: Database.Database;

/** @internal */
export function _setTasksDb(database: Database.Database): void {
  db = database;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): boolean {
  const result = db
    .prepare(
      `
    INSERT OR IGNORE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      task.id,
      task.group_folder,
      task.chat_jid,
      task.prompt,
      task.schedule_type,
      task.schedule_value,
      task.context_mode || 'isolated',
      task.next_run,
      task.status,
      task.created_at,
    );
  return result.changes > 0;
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

/**
 * Mark all active scheduled_tasks whose ID starts with the given prefix
 * as completed. Prevents stale duplicates from piling up when a task
 * is re-dispatched after a crash/restart.
 */
export function completeStaleTasksByPrefix(idPrefix: string): number {
  const result = db
    .prepare(
      `UPDATE scheduled_tasks SET status = 'completed', next_run = NULL
       WHERE id LIKE ? AND status = 'active'`,
    )
    .run(`${idPrefix}%`);
  return result.changes;
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result_json, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result ? JSON.stringify(log.result) : null,
    log.error,
  );
}

/**
 * Parse a task run result from the database row.
 * Handles: null, JSON in result_json, legacy text in result_legacy.
 */
export function parseTaskRunResult(row: {
  result_json?: string | null;
  result_legacy?: string | null;
}): TaskRunResult | null {
  if (row.result_json) {
    try {
      return JSON.parse(row.result_json) as TaskRunResult;
    } catch {
      return null;
    }
  }
  // Legacy fallback: wrap plain text in the structured shape
  if (row.result_legacy) {
    return {
      exitCode: 0,
      stdout: row.result_legacy,
      stderr: null,
      durationMs: 0,
      completedAt: '',
    };
  }
  return null;
}

// --- Task health summary ---

export interface TaskHealthSummary {
  totalRuns: number;
  successCount: number;
  failureCount: number;
  failedTasks: Array<{ task_id: string; error: string; run_at: string }>;
  avgDurationByTask: Array<{
    task_id: string;
    avg_duration_ms: number;
    max_duration_ms: number;
    run_count: number;
  }>;
}

/**
 * Aggregate task_run_logs for a given time window.
 * Returns counts by status, failed task details, and per-task duration stats.
 */
export function getTaskHealthSummary(
  hoursBack: number = 24,
  durationThresholdMs: number = 300000,
): TaskHealthSummary {
  const since = new Date(Date.now() - hoursBack * 3600_000).toISOString();

  const counts = db
    .prepare(
      `
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as successes,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as failures
      FROM task_run_logs
      WHERE run_at > ?
    `,
    )
    .get(since) as { total: number; successes: number; failures: number };

  const failedTasks = db
    .prepare(
      `
      SELECT task_id, error, run_at
      FROM task_run_logs
      WHERE run_at > ? AND status = 'error'
      ORDER BY run_at DESC
    `,
    )
    .all(since) as Array<{ task_id: string; error: string; run_at: string }>;

  const avgDurationByTask = db
    .prepare(
      `
      SELECT
        task_id,
        CAST(AVG(duration_ms) AS INTEGER) as avg_duration_ms,
        MAX(duration_ms) as max_duration_ms,
        COUNT(*) as run_count
      FROM task_run_logs
      WHERE run_at > ?
      GROUP BY task_id
      HAVING avg_duration_ms > ? OR max_duration_ms > ?
      ORDER BY avg_duration_ms DESC
    `,
    )
    .all(since, durationThresholdMs, durationThresholdMs) as Array<{
    task_id: string;
    avg_duration_ms: number;
    max_duration_ms: number;
    run_count: number;
  }>;

  return {
    totalRuns: counts.total,
    successCount: counts.successes,
    failureCount: counts.failures,
    failedTasks,
    avgDurationByTask,
  };
}
