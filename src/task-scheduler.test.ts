import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('advances next_run before enqueuing to prevent double-execution', async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();

    createTask({
      id: 'task-cron',
      group_folder: 'main',
      chat_jid: 'test@g.us',
      prompt: 'sweep',
      schedule_type: 'cron',
      schedule_value: '0 * * * *', // hourly
      context_mode: 'isolated',
      next_run: pastDate,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    let nextRunAtEnqueueTime: string | null | undefined;

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, _fn: () => Promise<void>) => {
        // Capture next_run at the moment enqueueTask is called
        const t = getTaskById('task-cron');
        nextRunAtEnqueueTime = t?.next_run;
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).toHaveBeenCalledOnce();
    // next_run should have been advanced past "now" before the task was enqueued
    expect(new Date(nextRunAtEnqueueTime!).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('sets next_run to null for once tasks before enqueuing', async () => {
    const pastDate = new Date(Date.now() - 60_000).toISOString();

    createTask({
      id: 'task-once',
      group_folder: 'main',
      chat_jid: 'test@g.us',
      prompt: 'run once',
      schedule_type: 'once',
      schedule_value: pastDate,
      context_mode: 'isolated',
      next_run: pastDate,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    let nextRunAtEnqueueTime: string | null | undefined;

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, _fn: () => Promise<void>) => {
        const t = getTaskById('task-once');
        nextRunAtEnqueueTime = t?.next_run;
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).toHaveBeenCalledOnce();
    // once tasks should have next_run set to null so they aren't re-picked
    expect(nextRunAtEnqueueTime).toBeNull();
  });
});

describe('computeNextRun', () => {
  it('returns next cron occurrence for cron tasks', () => {
    const result = computeNextRun({
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
    });
    expect(result).toBeTruthy();
    expect(new Date(result!).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns fromTime + interval for interval tasks', () => {
    const fromTime = new Date('2026-03-01T12:00:00Z').getTime();
    const intervalMs = 3600000; // 1 hour
    const result = computeNextRun(
      { schedule_type: 'interval', schedule_value: String(intervalMs) },
      fromTime,
    );
    expect(result).toBe(new Date(fromTime + intervalMs).toISOString());
  });

  it('returns null for once tasks', () => {
    const result = computeNextRun({
      schedule_type: 'once',
      schedule_value: '2026-03-01T00:00:00Z',
    });
    expect(result).toBeNull();
  });
});
