import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getDb, updateTaskAfterRun } from './db.js';
import {
  advanceTaskLifecycle,
  fossilizeTask,
  getTaskFossil,
  getTaskFossils,
  LIFECYCLE_THRESHOLDS,
  _resetLifecycleMonitorForTests,
  TaskLifecycleState,
} from './task-lifecycle.js';
import { ScheduledTask } from './types.js';

function makeTask(overrides: Partial<ScheduledTask & { lifecycle_state: TaskLifecycleState }> = {}): ScheduledTask {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    group_folder: 'test-group',
    chat_jid: 'test@g.us',
    prompt: 'test prompt',
    schedule_type: 'interval',
    schedule_value: '3600000',
    context_mode: 'isolated',
    next_run: new Date(Date.now() + 3600000).toISOString(),
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
  _resetLifecycleMonitorForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('task lifecycle', () => {
  it("new task has lifecycle_state='born'", () => {
    const task = makeTask();
    createTask(task);

    const row = getDb()
      .prepare('SELECT lifecycle_state FROM scheduled_tasks WHERE id = ?')
      .get(task.id) as { lifecycle_state: string } | undefined;

    expect(row?.lifecycle_state).toBe('born');
  });

  it('advanceTaskLifecycle returns null for brand new task with no last_run', () => {
    const task = makeTask();
    createTask(task);

    const result = advanceTaskLifecycle(task.id);

    expect(result).toBeNull();
  });

  it('advanceTaskLifecycle transitions born→active when last_run is set', () => {
    const task = makeTask();
    createTask(task);

    // updateTaskAfterRun sets last_run to now
    updateTaskAfterRun(task.id, new Date(Date.now() + 3600000).toISOString(), 'ok');

    const result = advanceTaskLifecycle(task.id);

    expect(result).toBe('active');

    const row = getDb()
      .prepare('SELECT lifecycle_state FROM scheduled_tasks WHERE id = ?')
      .get(task.id) as { lifecycle_state: string };
    expect(row.lifecycle_state).toBe('active');
  });

  it('advanceTaskLifecycle transitions active→stalled after STALL_THRESHOLD', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const task = makeTask();
    createTask(task);

    // Manually set last_run to 8 days ago and lifecycle_state to 'active'
    getDb()
      .prepare("UPDATE scheduled_tasks SET last_run = ?, lifecycle_state = 'active' WHERE id = ?")
      .run(eightDaysAgo.toISOString(), task.id);

    const now = new Date(eightDaysAgo.getTime() + 8 * 24 * 60 * 60 * 1000);
    const result = advanceTaskLifecycle(task.id, now);

    expect(result).toBe('stalled');
  });

  it('advanceTaskLifecycle transitions stalled→dying at DYING_THRESHOLD', () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    const task = makeTask();
    createTask(task);

    getDb()
      .prepare("UPDATE scheduled_tasks SET last_run = ?, lifecycle_state = 'stalled' WHERE id = ?")
      .run(fifteenDaysAgo.toISOString(), task.id);

    const now = new Date(fifteenDaysAgo.getTime() + 15 * 24 * 60 * 60 * 1000);
    const result = advanceTaskLifecycle(task.id, now);

    expect(result).toBe('dying');
  });

  it('advanceTaskLifecycle transitions dying→dead at DEAD_THRESHOLD', () => {
    const twentyTwoDaysAgo = new Date(Date.now() - 22 * 24 * 60 * 60 * 1000);
    const task = makeTask();
    createTask(task);

    getDb()
      .prepare("UPDATE scheduled_tasks SET last_run = ?, lifecycle_state = 'dying' WHERE id = ?")
      .run(twentyTwoDaysAgo.toISOString(), task.id);

    const now = new Date(twentyTwoDaysAgo.getTime() + 22 * 24 * 60 * 60 * 1000);
    const result = advanceTaskLifecycle(task.id, now);

    expect(result).toBe('dead');
  });

  it('fossilizeTask creates task_fossils row and removes from scheduled_tasks', () => {
    const task = makeTask();
    createTask(task);

    fossilizeTask(task.id);

    const scheduledRow = getDb()
      .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
      .get(task.id);
    expect(scheduledRow).toBeUndefined();

    const fossilRow = getDb()
      .prepare('SELECT * FROM task_fossils WHERE id = ?')
      .get(task.id);
    expect(fossilRow).toBeDefined();
  });

  it('fossilizeTask preserves context_snapshot with last_result', () => {
    const task = makeTask();
    createTask(task);

    // Set a last_result
    getDb()
      .prepare("UPDATE scheduled_tasks SET last_result = ?, last_run = ? WHERE id = ?")
      .run('some result text', new Date().toISOString(), task.id);

    fossilizeTask(task.id);

    const fossil = getTaskFossil(task.id);
    expect(fossil).toBeDefined();
    expect(fossil?.context_snapshot).not.toBeNull();
    expect((fossil?.context_snapshot as Record<string, unknown>)?.last_result).toBe('some result text');
    expect(typeof (fossil?.context_snapshot as Record<string, unknown>)?.run_count).toBe('number');
  });

  it('getTaskFossils filters by group_folder', () => {
    const task1 = makeTask({ id: 'task-alpha-1', group_folder: 'group-alpha' });
    const task2 = makeTask({ id: 'task-alpha-2', group_folder: 'group-alpha' });
    const task3 = makeTask({ id: 'task-beta-1', group_folder: 'group-beta' });

    createTask(task1);
    createTask(task2);
    createTask(task3);

    fossilizeTask(task1.id);
    fossilizeTask(task2.id);
    fossilizeTask(task3.id);

    const alphaFossils = getTaskFossils('group-alpha');
    expect(alphaFossils).toHaveLength(2);
    expect(alphaFossils.every((f) => f.group_folder === 'group-alpha')).toBe(true);

    const betaFossils = getTaskFossils('group-beta');
    expect(betaFossils).toHaveLength(1);
    expect(betaFossils[0].group_folder).toBe('group-beta');
  });

  it("advanceTaskLifecycle returns null for status='paused'", () => {
    const task = makeTask({ status: 'paused' });
    createTask(task);

    // Set a last_run so it would otherwise transition
    getDb()
      .prepare("UPDATE scheduled_tasks SET last_run = ? WHERE id = ?")
      .run(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), task.id);

    const result = advanceTaskLifecycle(task.id);
    expect(result).toBeNull();
  });
});
