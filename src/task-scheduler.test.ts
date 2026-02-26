import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import { localTimeToUtc } from './ipc.js';
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

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      timezone: null,
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

  it('stores timezone on created tasks', () => {
    createTask({
      id: 'task-tz',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'remind me',
      schedule_type: 'once',
      schedule_value: '2026-03-01T17:00:00',
      context_mode: 'isolated',
      timezone: 'America/Los_Angeles',
      next_run: '2026-03-02T01:00:00.000Z',
      status: 'active',
      created_at: '2026-02-26T00:00:00.000Z',
    });

    const task = getTaskById('task-tz');
    expect(task?.timezone).toBe('America/Los_Angeles');
  });

  it('stores null timezone for tasks without explicit timezone', () => {
    createTask({
      id: 'task-no-tz',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'remind me',
      schedule_type: 'once',
      schedule_value: '2026-03-01T17:00:00',
      context_mode: 'isolated',
      timezone: null,
      next_run: '2026-03-01T17:00:00.000Z',
      status: 'active',
      created_at: '2026-02-26T00:00:00.000Z',
    });

    const task = getTaskById('task-no-tz');
    expect(task?.timezone).toBeNull();
  });
});

describe('localTimeToUtc', () => {
  it('converts PST local time to correct UTC', () => {
    // 5pm PST = 1am next day UTC (PST is UTC-8)
    const result = localTimeToUtc('2026-03-01T17:00:00', 'America/Los_Angeles');
    expect(result.toISOString()).toBe('2026-03-02T01:00:00.000Z');
  });

  it('converts CET local time to correct UTC', () => {
    // 9am CET = 8am UTC (CET is UTC+1 in winter)
    const result = localTimeToUtc('2026-02-26T09:00:00', 'Europe/Berlin');
    expect(result.toISOString()).toBe('2026-02-26T08:00:00.000Z');
  });

  it('converts UTC local time to same UTC', () => {
    const result = localTimeToUtc('2026-02-26T15:00:00', 'UTC');
    expect(result.toISOString()).toBe('2026-02-26T15:00:00.000Z');
  });

  it('handles JST (UTC+9) correctly', () => {
    // 9am JST = midnight UTC
    const result = localTimeToUtc('2026-03-01T09:00:00', 'Asia/Tokyo');
    expect(result.toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });

  it('throws on invalid format', () => {
    expect(() => localTimeToUtc('not-a-date', 'UTC')).toThrow();
  });
});
