import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runContainerAgentMock, writeTasksSnapshotMock } = vi.hoisted(() => ({
  runContainerAgentMock: vi.fn(),
  writeTasksSnapshotMock: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: runContainerAgentMock,
  writeTasksSnapshot: writeTasksSnapshotMock,
}));

import { createSessionStore } from './agent/session-store.js';
import {
  _initTestDatabase,
  createTask,
  deleteSession,
  getSession,
  getTaskById,
  setSession,
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
    runContainerAgentMock.mockReset();
    writeTasksSnapshotMock.mockReset();
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
      sessionStore: createSessionStore({
        getSession,
        setSession,
        deleteSession,
      }),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('reuses and updates the active provider session without touching other providers', async () => {
    // Arrange
    createTask({
      id: 'task-provider-session',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });
    setSession('other-group', 'claude-session', 'claude-code');
    setSession('other-group', 'codex-session', 'codex');
    const sessionStore = createSessionStore({
      getSession,
      setSession,
      deleteSession,
    });
    const taskRuns: Array<Promise<void>> = [];

    runContainerAgentMock.mockResolvedValue({
      status: 'success',
      result: 'scheduled result',
      newSessionId: 'codex-session-next',
    });

    // Act
    startSchedulerLoop({
      registeredGroups: () => ({
        'other@g.us': {
          name: 'Other',
          folder: 'other-group',
          trigger: '@Andy',
          added_at: '2026-02-22T00:00:00.000Z',
          providerId: 'codex',
        },
      }),
      sessionStore,
      queue: {
        enqueueTask: (
          _groupJid: string,
          _taskId: string,
          fn: () => Promise<void>,
        ) => {
          taskRuns.push(fn());
        },
        notifyIdle: () => {},
        closeStdin: () => {},
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(taskRuns);

    // Assert
    const [, invocation] = runContainerAgentMock.mock.calls[0];
    expect(invocation.sessionId).toBe('codex-session');
    expect(getSession('other-group', 'codex')).toBe('codex-session-next');
    expect(getSession('other-group', 'claude-code')).toBe('claude-session');
  });

  it('uses the group provider at execution time when the provider changed after task creation', async () => {
    // Arrange
    createTask({
      id: 'task-provider-switch',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'run after switch',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });
    setSession('other-group', 'claude-session', 'claude-code');
    setSession('other-group', 'codex-session', 'codex');
    const sessionStore = createSessionStore({
      getSession,
      setSession,
      deleteSession,
    });
    const taskRuns: Array<Promise<void>> = [];
    const groups = {
      'other@g.us': {
        name: 'Other',
        folder: 'other-group',
        trigger: '@Andy',
        added_at: '2026-02-22T00:00:00.000Z',
        providerId: 'claude-code',
      },
    };

    runContainerAgentMock.mockResolvedValue({
      status: 'success',
      result: null,
      newSessionId: 'codex-session-next',
    });

    groups['other@g.us'] = {
      ...groups['other@g.us'],
      providerId: 'codex',
    };

    // Act
    startSchedulerLoop({
      registeredGroups: () => groups,
      sessionStore,
      queue: {
        enqueueTask: (
          _groupJid: string,
          _taskId: string,
          fn: () => Promise<void>,
        ) => {
          taskRuns.push(fn());
        },
        notifyIdle: () => {},
        closeStdin: () => {},
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(taskRuns);

    // Assert
    const [groupArg, invocation] = runContainerAgentMock.mock.calls[0];
    expect(groupArg.providerId).toBe('codex');
    expect(invocation.sessionId).toBe('codex-session');
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
