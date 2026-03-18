import { CronExpressionParser } from 'cron-parser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  rehydrateTaskTimezones,
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
      created_tz: 'UTC',
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
      created_tz: 'UTC',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
      created_tz: 'UTC',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
      created_tz: 'UTC',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});

describe('rehydrateTaskTimezones', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('corrects drifted cron task next_run and updates created_tz', () => {
    // Create a cron task "0 9 * * *" that was created under UTC
    const utcNextRun = CronExpressionParser.parse('0 9 * * *', {
      tz: 'UTC',
    })
      .next()
      .toISOString();

    createTask({
      id: 'drift-cron-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'daily digest',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: utcNextRun,
      status: 'active',
      created_at: '2026-03-17T00:00:00.000Z',
      created_tz: 'UTC',
    });

    // Run rehydration under America/Chicago
    rehydrateTaskTimezones('America/Chicago');

    // Compute what the correct next_run should be under America/Chicago
    const expectedNextRun = CronExpressionParser.parse('0 9 * * *', {
      tz: 'America/Chicago',
    })
      .next()
      .toISOString();

    const task = getTaskById('drift-cron-1');
    expect(task).toBeDefined();
    expect(task!.next_run).toBe(expectedNextRun);
    expect(task!.created_tz).toBe('America/Chicago');
  });

  it('skips cron task when created_tz matches current TIMEZONE', () => {
    // Create a cron task already aligned with America/Chicago
    const chicagoNextRun = CronExpressionParser.parse('0 9 * * *', {
      tz: 'America/Chicago',
    })
      .next()
      .toISOString();

    createTask({
      id: 'matching-tz-cron',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'daily digest',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: chicagoNextRun,
      status: 'active',
      created_at: '2026-03-17T00:00:00.000Z',
      created_tz: 'America/Chicago',
    });

    // Run rehydration under the same timezone
    rehydrateTaskTimezones('America/Chicago');

    // Verify next_run is unchanged
    const task = getTaskById('matching-tz-cron');
    expect(task).toBeDefined();
    expect(task!.next_run).toBe(chicagoNextRun);
    expect(task!.created_tz).toBe('America/Chicago');
  });

  it('skips interval tasks during rehydration', () => {
    // Create an interval task with created_tz = 'UTC' (different from target tz)
    const intervalNextRun = new Date(Date.now() + 60_000).toISOString();

    createTask({
      id: 'interval-skip-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'check status',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: intervalNextRun,
      status: 'active',
      created_at: '2026-03-17T00:00:00.000Z',
      created_tz: 'UTC',
    });

    // Run rehydration under America/Chicago
    rehydrateTaskTimezones('America/Chicago');

    // Verify next_run is unchanged — interval tasks are timezone-independent
    const task = getTaskById('interval-skip-1');
    expect(task).toBeDefined();
    expect(task!.next_run).toBe(intervalNextRun);
    expect(task!.created_tz).toBe('UTC');
  });

  it('corrects paused cron tasks during rehydration', () => {
    // Create a paused cron task "0 9 * * *" that was created under UTC
    const utcNextRun = CronExpressionParser.parse('0 9 * * *', {
      tz: 'UTC',
    })
      .next()
      .toISOString();

    createTask({
      id: 'paused-cron-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'daily digest',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: utcNextRun,
      status: 'paused',
      created_at: '2026-03-17T00:00:00.000Z',
      created_tz: 'UTC',
    });

    // Run rehydration under America/Chicago
    rehydrateTaskTimezones('America/Chicago');

    // Compute what the correct next_run should be under America/Chicago
    const expectedNextRun = CronExpressionParser.parse('0 9 * * *', {
      tz: 'America/Chicago',
    })
      .next()
      .toISOString();

    const task = getTaskById('paused-cron-1');
    expect(task).toBeDefined();
    // Both next_run and created_tz should be corrected
    expect(task!.next_run).toBe(expectedNextRun);
    expect(task!.created_tz).toBe('America/Chicago');
    // Status should remain paused (rehydration does not change status)
    expect(task!.status).toBe('paused');
  });

  it('skips once-type tasks during rehydration', () => {
    // Create a once task with created_tz = 'UTC' (different from target tz)
    const onceNextRun = new Date(Date.now() + 3_600_000).toISOString();

    createTask({
      id: 'once-skip-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'one-time reminder',
      schedule_type: 'once',
      schedule_value: onceNextRun,
      context_mode: 'isolated',
      next_run: onceNextRun,
      status: 'active',
      created_at: '2026-03-17T00:00:00.000Z',
      created_tz: 'UTC',
    });

    // Run rehydration under America/Chicago
    rehydrateTaskTimezones('America/Chicago');

    // Verify next_run is unchanged — once tasks use absolute timestamps
    const task = getTaskById('once-skip-1');
    expect(task).toBeDefined();
    expect(task!.next_run).toBe(onceNextRun);
    expect(task!.created_tz).toBe('UTC');
  });

  it('skips completed cron tasks during rehydration', () => {
    // Create a completed cron task with created_tz = 'UTC' (different from target tz)
    const utcNextRun = CronExpressionParser.parse('0 9 * * *', {
      tz: 'UTC',
    })
      .next()
      .toISOString();

    createTask({
      id: 'completed-cron-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'daily digest',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      next_run: utcNextRun,
      status: 'completed',
      created_at: '2026-03-17T00:00:00.000Z',
      created_tz: 'UTC',
    });

    // Run rehydration under America/Chicago
    rehydrateTaskTimezones('America/Chicago');

    // Verify next_run is unchanged — completed tasks will never fire again
    const task = getTaskById('completed-cron-1');
    expect(task).toBeDefined();
    expect(task!.next_run).toBe(utcNextRun);
    expect(task!.created_tz).toBe('UTC');
  });
});
