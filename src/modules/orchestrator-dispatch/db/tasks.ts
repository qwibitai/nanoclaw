import { getDb } from '../../../db/connection.js';

export interface Task {
  task_id: string;
  idempotency_key: string;
  parent_session_id: string;
  parent_agent_group_id: string;
  parent_messaging_group_id: string | null;
  target_agent_group_id: string;
  child_session_id: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  task_content: string;
  request_hash: string;
  deadline: string | null;
  parent_platform_message_id: string | null;
  child_platform_thread_id: string | null;
  child_messaging_group_id: string | null;
  admitted_at: string;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  last_progress_at: string | null;
  last_progress_message: string | null;
  fail_reason: string | null;
  result_summary: string | null;
  dispatch_completion_attempts: number;
  completion_lease_at: string | null;
  surface_mode: 'pending' | 'native_thread' | 'headless';
  created_at: string;
}

const ALLOWED_ARTIFACT_COLUMNS = new Set([
  'parent_platform_message_id',
  'child_platform_thread_id',
  'child_messaging_group_id',
  'child_session_id',
  'last_progress_at',
  'last_progress_message',
  'started_at',
]);

export function insertTaskAtomic(row: Omit<Task, 'created_at'>): Task | null {
  const createdAt = new Date().toISOString();
  const result = getDb()
    .prepare(
      `INSERT INTO tasks (
        task_id, idempotency_key, parent_session_id, parent_agent_group_id,
        parent_messaging_group_id, target_agent_group_id, child_session_id,
        status, task_content, request_hash, deadline, parent_platform_message_id,
        child_platform_thread_id, child_messaging_group_id, admitted_at,
        started_at, completed_at, failed_at, cancelled_at, last_progress_at,
        last_progress_message, fail_reason, result_summary,
        dispatch_completion_attempts, completion_lease_at, surface_mode, created_at
      ) VALUES (
        @task_id, @idempotency_key, @parent_session_id, @parent_agent_group_id,
        @parent_messaging_group_id, @target_agent_group_id, @child_session_id,
        @status, @task_content, @request_hash, @deadline, @parent_platform_message_id,
        @child_platform_thread_id, @child_messaging_group_id, @admitted_at,
        @started_at, @completed_at, @failed_at, @cancelled_at, @last_progress_at,
        @last_progress_message, @fail_reason, @result_summary,
        @dispatch_completion_attempts, @completion_lease_at, @surface_mode, @created_at
      )
      ON CONFLICT(parent_session_id, idempotency_key) DO NOTHING
      RETURNING *`,
    )
    .get({ ...row, created_at: createdAt }) as Task | undefined;

  return result ?? null;
}

export function getTaskById(id: string): Task | null {
  return (getDb().prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(id) as Task | undefined) ?? null;
}

export function getTaskByParentAndIdempotency(parentSessionId: string, idempotencyKey: string): Task | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM tasks WHERE parent_session_id = ? AND idempotency_key = ?`)
      .get(parentSessionId, idempotencyKey) as Task | undefined) ?? null
  );
}

export function acquireCompletionLease(taskId: string, leaseExpirySec: number = 60): Task | null {
  const now = new Date().toISOString();
  // Compute expired threshold: now minus leaseExpirySec
  const expiredBefore = new Date(Date.now() - leaseExpirySec * 1000).toISOString();

  const result = getDb()
    .prepare(
      `UPDATE tasks
          SET completion_lease_at = ?
        WHERE task_id = ?
          AND status = 'pending'
          AND (completion_lease_at IS NULL OR completion_lease_at < ?)
        RETURNING *`,
    )
    .get(now, taskId, expiredBefore) as Task | undefined;

  return result ?? null;
}

export function updateArtifactColumn(taskId: string, columnName: string, value: string): boolean {
  if (!ALLOWED_ARTIFACT_COLUMNS.has(columnName)) {
    throw new Error(`updateArtifactColumn: column '${columnName}' is not in the allowed artifact set`);
  }
  const result = getDb()
    .prepare(
      `UPDATE tasks
          SET "${columnName}" = ?
        WHERE task_id = ?
          AND status = 'pending'
          AND "${columnName}" IS NULL`,
    )
    .run(value, taskId);

  return result.changes === 1;
}

export function transitionToTerminal(
  taskId: string,
  terminalStatus: 'completed' | 'failed' | 'cancelled',
  extraCols: Record<string, unknown>,
): boolean {
  const sets: string[] = [`status = ?`];
  const values: unknown[] = [terminalStatus];

  for (const [col, val] of Object.entries(extraCols)) {
    sets.push(`"${col}" = ?`);
    values.push(val);
  }
  values.push(taskId);

  const result = getDb()
    .prepare(
      `UPDATE tasks
          SET ${sets.join(', ')}
        WHERE task_id = ?
          AND status IN ('pending', 'running')`,
    )
    .run(...(values as Parameters<typeof getDb>));

  return result.changes === 1;
}

export function getOrphanedTasks(): Task[] {
  const expiredBefore = new Date(Date.now() - 60 * 1000).toISOString();
  return getDb()
    .prepare(
      `SELECT * FROM tasks
        WHERE status = 'pending'
          AND admitted_at IS NOT NULL
          AND child_session_id IS NULL
          AND (completion_lease_at IS NULL OR completion_lease_at < ?)`,
    )
    .all(expiredBefore) as Task[];
}

export function incrementCompletionAttempts(taskId: string): number {
  const result = getDb()
    .prepare(
      `UPDATE tasks
          SET dispatch_completion_attempts = dispatch_completion_attempts + 1
        WHERE task_id = ?
        RETURNING dispatch_completion_attempts`,
    )
    .get(taskId) as { dispatch_completion_attempts: number } | undefined;

  return result?.dispatch_completion_attempts ?? 0;
}

export function getTaskByChildSession(childSessionId: string): Task | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM tasks WHERE child_session_id = ?`)
      .get(childSessionId) as Task | undefined) ?? null
  );
}

export function getActiveTasks(): Task[] {
  return getDb()
    .prepare(`SELECT * FROM tasks WHERE status IN ('pending', 'running')`)
    .all() as Task[];
}

export function countActiveByParent(parentSessionId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) as cnt FROM tasks
        WHERE parent_session_id = ? AND status IN ('pending', 'running')`,
    )
    .get(parentSessionId) as { cnt: number };
  return row.cnt;
}
