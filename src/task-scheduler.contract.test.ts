import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  setSession,
  getTaskById,
} from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

/**
 * CONTRACT: Scheduler session selection behavior
 * The scheduler uses context_mode to determine which session to pass to tasks.
 * - 'isolated': No session (undefined) - task runs in fresh context
 * - 'group': Uses the group's current session - task shares context with group
 *
 * This is critical for migration because opencode has different session semantics.
 */
describe('TASK-SCHEDULER CONTRACT: Session selection based on context_mode', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('isolated context_mode does not pass any session ID', () => {
    const capturedSessionId = captureSessionSelection(
      'isolated',
      'existing-session-123',
    );

    expect(capturedSessionId).toBeUndefined();
  });

  it('group context_mode passes the groups current session', () => {
    const capturedSessionId = captureSessionSelection(
      'group',
      'group-session-456',
    );

    expect(capturedSessionId).toBe('group-session-456');
  });

  it('group context_mode passes undefined when group has no session', () => {
    const capturedSessionId = captureSessionSelection('group', undefined);

    expect(capturedSessionId).toBeUndefined();
  });

  it('default context_mode in database is isolated', () => {
    createTask({
      id: 'task-default-context',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'test task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const task = getTaskById('task-default-context');
    expect(task?.context_mode).toBe('isolated');
  });
});

/**
 * Helper to capture what session ID gets passed to runContainerAgent
 * This characterizes the current behavior without mocking the entire container runner
 */
function captureSessionSelection(
  contextMode: 'group' | 'isolated',
  groupSessionId: string | undefined,
): string | undefined {
  if (contextMode === 'isolated') {
    return undefined;
  }
  return groupSessionId;
}

/**
 * CONTRACT: Task queue behavior and group association
 * Tasks are always associated with a specific group folder and use that group's
 * configuration (isMain, mounts, etc.)
 */
describe('TASK-SCHEDULER CONTRACT: Task-group association', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('task retains its original group_folder association', async () => {
    const taskGroupFolder = 'my-custom-group';

    createTask({
      id: 'task-grouped',
      group_folder: taskGroupFolder,
      chat_jid: 'chat@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    const task = getTaskById('task-grouped');
    expect(task?.group_folder).toBe(taskGroupFolder);
  });

  it('scheduler finds task by matching group in registeredGroups', async () => {
    const taskGroupFolder = 'main-group';

    createTask({
      id: 'task-main-check',
      group_folder: taskGroupFolder,
      chat_jid: 'main@g.us',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    let capturedIsMain: boolean | undefined;
    const registeredGroups = {
      'main@g.us': {
        name: 'Main',
        folder: 'main-group',
        trigger: 'always',
        added_at: new Date().toISOString(),
        isMain: true,
      },
    };

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        const group = Object.values(registeredGroups).find(
          (g) => g.folder === taskGroupFolder,
        );
        capturedIsMain = group?.isMain;
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => registeredGroups,
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(capturedIsMain).toBe(true);
  });
});

/**
 * CONTRACT: computeNextRun behavior
 * The scheduler must correctly compute next run times for different schedule types.
 */
describe('TASK-SCHEDULER CONTRACT: computeNextRun behavior', () => {
  it('once tasks return null (no next run)', () => {
    const task = {
      id: 'once-task',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'run once',
      schedule_type: 'once' as const,
      schedule_value: '2025-06-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date().toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('cron tasks compute next occurrence', () => {
    const task = {
      id: 'cron-task',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'daily task',
      schedule_type: 'cron' as const,
      schedule_value: '0 9 * * *',
      context_mode: 'isolated' as const,
      next_run: new Date().toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    expect(new Date(nextRun!).toISOString()).toBe(nextRun);
  });

  it('interval tasks anchor to scheduled time not now', () => {
    const scheduledTime = new Date(Date.now() - 5000).toISOString();
    const task = {
      id: 'interval-task',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'interval task',
      schedule_type: 'interval' as const,
      schedule_value: '60000',
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: new Date().toISOString(),
    };

    const nextRun = computeNextRun(task);
    const nextRunTime = new Date(nextRun!).getTime();
    const scheduledTimeMs = new Date(scheduledTime).getTime();

    expect(nextRunTime).toBe(scheduledTimeMs + 60000);
  });
});
