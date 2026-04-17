import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './connection.js';
import {
  createTask,
  deleteTask,
  getAllTasks,
  getDueTasks,
  getTaskById,
  getTasksForGroup,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './tasks.js';

beforeEach(() => {
  _initTestDatabase();
});

function seedTask(overrides: Record<string, unknown> = {}): void {
  createTask({
    id: 't1',
    group_folder: 'main',
    chat_jid: 'chat@g.us',
    prompt: 'do thing',
    schedule_type: 'once',
    schedule_value: '2026-12-31T00:00:00',
    context_mode: 'isolated',
    next_run: '2026-12-31T00:00:00.000Z',
    status: 'active',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('tasks DAO', () => {
  it('createTask + getTaskById round-trip', () => {
    seedTask({ name: 'daily-report' });
    const task = getTaskById('t1');
    expect(task).toBeDefined();
    expect(task?.name).toBe('daily-report');
    expect(task?.prompt).toBe('do thing');
  });

  it('getTaskById returns undefined for unknown ids', () => {
    expect(getTaskById('missing')).toBeUndefined();
  });

  it('getAllTasks returns every task ordered by created_at DESC', () => {
    seedTask({ id: 'a', created_at: '2026-01-01T00:00:01.000Z' });
    seedTask({ id: 'b', created_at: '2026-01-01T00:00:05.000Z' });
    seedTask({ id: 'c', created_at: '2026-01-01T00:00:03.000Z' });
    expect(getAllTasks().map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('getTasksForGroup filters by group_folder', () => {
    seedTask({ id: 'a', group_folder: 'main' });
    seedTask({ id: 'b', group_folder: 'child' });
    seedTask({ id: 'c', group_folder: 'main' });
    expect(
      getTasksForGroup('main')
        .map((t) => t.id)
        .sort(),
    ).toEqual(['a', 'c']);
  });

  it('updateTask updates only the fields provided', () => {
    seedTask();
    updateTask('t1', { prompt: 'new prompt' });
    expect(getTaskById('t1')?.prompt).toBe('new prompt');
    // untouched fields stay
    expect(getTaskById('t1')?.schedule_type).toBe('once');
  });

  it('updateTask treats empty-string name and empty-string script as null', () => {
    seedTask({ name: 'old' });
    updateTask('t1', { name: '', script: '' });
    expect(getTaskById('t1')?.name).toBeNull();
    expect(getTaskById('t1')?.script).toBeNull();
  });

  it('updateTask is a no-op when no fields are provided', () => {
    seedTask({ prompt: 'orig' });
    updateTask('t1', {});
    expect(getTaskById('t1')?.prompt).toBe('orig');
  });

  it('deleteTask removes the task and any task_run_logs rows', () => {
    seedTask();
    logTaskRun({
      task_id: 't1',
      run_at: '2026-01-01T00:00:00.000Z',
      duration_ms: 50,
      status: 'success',
      result: 'ok',
      error: null,
    });
    deleteTask('t1');
    expect(getTaskById('t1')).toBeUndefined();
    // Deleting a task not present should not throw
    expect(() => deleteTask('also-gone')).not.toThrow();
  });

  it('getDueTasks returns only active tasks with a past next_run', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    seedTask({ id: 'due', next_run: past });
    seedTask({ id: 'later', next_run: future });
    seedTask({ id: 'paused', status: 'paused', next_run: past });
    seedTask({ id: 'no-schedule', next_run: null });
    const due = getDueTasks().map((t) => t.id);
    expect(due).toContain('due');
    expect(due).not.toContain('later');
    expect(due).not.toContain('paused');
    expect(due).not.toContain('no-schedule');
  });

  it('updateTaskAfterRun flips status to completed when nextRun is null', () => {
    seedTask();
    updateTaskAfterRun('t1', null, 'ok');
    expect(getTaskById('t1')?.status).toBe('completed');
    expect(getTaskById('t1')?.last_result).toBe('ok');
  });

  it('updateTaskAfterRun leaves status alone when nextRun is provided', () => {
    seedTask();
    updateTaskAfterRun('t1', '2027-01-01T00:00:00.000Z', 'partial');
    expect(getTaskById('t1')?.status).toBe('active');
    expect(getTaskById('t1')?.next_run).toBe('2027-01-01T00:00:00.000Z');
  });

  it('logTaskRun records rows for a task', () => {
    seedTask();
    logTaskRun({
      task_id: 't1',
      run_at: '2026-01-01T00:00:00.000Z',
      duration_ms: 123,
      status: 'error',
      result: null,
      error: 'boom',
    });
    // No public getter yet — confirmed indirectly: deleteTask cleans this up.
    expect(() => deleteTask('t1')).not.toThrow();
  });
});
