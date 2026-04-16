import type { ScheduledTask, TaskRunLog } from '../types.js';

import { getDb } from './connection.js';

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  getDb()
    .prepare(
      `
    INSERT INTO scheduled_tasks (id, name, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, silent, model, effort, thinking_budget, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      task.id,
      task.name || null,
      task.group_folder,
      task.chat_jid,
      task.prompt,
      task.script || null,
      task.schedule_type,
      task.schedule_value,
      task.context_mode || 'isolated',
      task.silent ? 1 : 0,
      task.model || null,
      task.effort || null,
      task.thinking_budget || null,
      task.next_run,
      task.status,
      task.created_at,
    );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as ScheduledTask | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return getDb()
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'name'
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'model'
      | 'effort'
      | 'thinking_budget'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name || null);
  }
  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
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
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model || null);
  }
  if (updates.effort !== undefined) {
    fields.push('effort = ?');
    values.push(updates.effort || null);
  }
  if (updates.thinking_budget !== undefined) {
    fields.push('thinking_budget = ?');
    values.push(updates.thinking_budget || null);
  }

  if (fields.length === 0) return;

  values.push(id);
  getDb()
    .prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function deleteTask(id: string): void {
  const db = getDb();
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return getDb()
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
  getDb()
    .prepare(
      `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
    )
    .run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  getDb()
    .prepare(
      `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      log.task_id,
      log.run_at,
      log.duration_ms,
      log.status,
      log.result,
      log.error,
    );
}
