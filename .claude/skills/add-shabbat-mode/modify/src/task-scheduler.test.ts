import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
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

  it('advances next_run before enqueuing to prevent duplicate execution', async () => {
    const now = new Date();
    const pastTime = new Date(now.getTime() - 60_000).toISOString();

    createTask({
      id: 'task-cron',
      group_folder: 'main',
      chat_jid: 'test@s.whatsapp.net',
      prompt: 'daily summary',
      schedule_type: 'cron',
      schedule_value: '0 20 * * *',
      context_mode: 'isolated',
      next_run: pastTime,
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    let nextRunAtEnqueue: string | null = null;

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, _fn: () => Promise<void>) => {
        // Capture next_run at the moment enqueueTask is called
        const task = getTaskById('task-cron');
        nextRunAtEnqueue = task?.next_run ?? null;
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
    // next_run should already be in the future when enqueueTask runs
    expect(nextRunAtEnqueue).not.toBeNull();
    expect(new Date(nextRunAtEnqueue!).getTime()).toBeGreaterThan(
      now.getTime(),
    );
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
});
