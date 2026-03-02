import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  claimDueTasks,
  createTask,
  getTaskById,
} from './db.js';
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

  it('claimDueTasks prevents duplicate execution across polls', () => {
    // Create an interval task that is due now
    createTask({
      id: 'task-interval',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'check something',
      schedule_type: 'interval',
      schedule_value: '300000', // 5 minutes
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    // First claim should return the task
    const firstClaim = claimDueTasks(computeNextRun);
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0].id).toBe('task-interval');

    // Second claim (simulating next poll) should return nothing —
    // next_run was already advanced into the future
    const secondClaim = claimDueTasks(computeNextRun);
    expect(secondClaim).toHaveLength(0);

    // Verify next_run was advanced to ~5 minutes from the scheduled time
    const task = getTaskById('task-interval');
    expect(task).toBeDefined();
    expect(task!.status).toBe('active');
    expect(new Date(task!.next_run!).getTime()).toBeGreaterThan(Date.now());
  });

  it('claimDueTasks clears next_run for once-tasks to prevent re-claim', () => {
    createTask({
      id: 'task-once',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'do something once',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const claimed = claimDueTasks(computeNextRun);
    expect(claimed).toHaveLength(1);

    // next_run cleared — second poll finds nothing
    const secondClaim = claimDueTasks(computeNextRun);
    expect(secondClaim).toHaveLength(0);

    // Task is still active until execution completes
    const task = getTaskById('task-once');
    expect(task!.next_run).toBeNull();
    expect(task!.status).toBe('active');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });
});
