/**
 * task_run_logs — execution history for scheduled tasks.
 *
 * Restores the v1 surface (`store/messages.db.task_run_logs`) lost in the
 * v2 rewrite. One row per occurrence of a task message processed by the
 * container. `task_id` is the message id; `series_id` ties recurring
 * occurrences together (matches the v2 messages_in.series_id semantics).
 *
 * The container is the sole writer — see connection.ts for the table
 * bootstrap, and the poll-loop for write call sites.
 */
import { getOutboundDb } from './connection.js';

export interface TaskRunLog {
  id: number;
  task_id: string;
  series_id: string | null;
  run_at: string;
  duration_ms: number;
  status: 'completed' | 'failed' | 'skipped';
  result: string | null;
  error: string | null;
}

export interface RecordTaskRunInput {
  task_id: string;
  series_id?: string | null;
  run_at: string;
  duration_ms: number;
  status: 'completed' | 'failed' | 'skipped';
  result?: string | null;
  error?: string | null;
}

export function recordTaskRun(input: RecordTaskRunInput): void {
  getOutboundDb()
    .prepare(
      `INSERT INTO task_run_logs (task_id, series_id, run_at, duration_ms, status, result, error)
       VALUES ($task_id, $series_id, $run_at, $duration_ms, $status, $result, $error)`,
    )
    .run({
      $task_id: input.task_id,
      $series_id: input.series_id ?? null,
      $run_at: input.run_at,
      $duration_ms: input.duration_ms,
      $status: input.status,
      $result: input.result ?? null,
      $error: input.error ?? null,
    });
}

export interface ListTaskRunsOptions {
  taskOrSeriesId?: string;
  limit?: number;
}

/**
 * List task runs, newest first. When `taskOrSeriesId` is set, matches both
 * `task_id` (single occurrence) and `series_id` (any occurrence in a
 * recurring series) so the agent can pass the id from list_tasks without
 * caring which it is.
 */
export function listTaskRuns(opts: ListTaskRunsOptions = {}): TaskRunLog[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const db = getOutboundDb();
  if (opts.taskOrSeriesId) {
    return db
      .prepare(
        `SELECT * FROM task_run_logs
          WHERE task_id = ? OR series_id = ?
          ORDER BY run_at DESC
          LIMIT ?`,
      )
      .all(opts.taskOrSeriesId, opts.taskOrSeriesId, limit) as TaskRunLog[];
  }
  return db.prepare(`SELECT * FROM task_run_logs ORDER BY run_at DESC LIMIT ?`).all(limit) as TaskRunLog[];
}
