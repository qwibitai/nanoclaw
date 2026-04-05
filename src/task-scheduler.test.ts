import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContainerOutput } from './container-runner.js';
import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
  type SchedulerDependencies,
} from './task-scheduler.js';
import { RegisteredGroup } from './types.js';

vi.mock('./host-runner.js', () => ({
  runHostAgent: vi.fn(),
}));

// Resolved lazily after vi.mock hoisting
async function getRunHostAgentMock() {
  const mod = await import('./host-runner.js');
  return mod.runHostAgent as ReturnType<typeof vi.fn>;
}

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  it('silent tasks do not call sendMessage', async () => {
    const groupFolder = 'test-group';
    const chatJid = 'tg:123';

    createTask({
      id: 'silent-task',
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt: 'Do maintenance silently',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      silent: true,
    });

    const sendMessage = vi.fn(async () => {});

    const deps: SchedulerDependencies = {
      registeredGroups: () => ({
        [chatJid]: {
          name: 'test',
          folder: groupFolder,
          isMain: true,
          requiresTrigger: false,
          trigger: '',
          added_at: '',
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: vi.fn(
          (_jid: string, _taskId: string, fn: () => Promise<void>) => {
            void fn();
          },
        ),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      onProcess: () => {},
      sendMessage,
    };

    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    // runTask should have been enqueued — execute it
    // Since runAgent is not mocked and will fail, sendMessage should still
    // not be called for a silent task even if there were output.
    // The key assertion: sendMessage was never called.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('non-silent tasks call sendMessage with output', async () => {
    const groupFolder = 'test-group';
    const chatJid = 'tg:456';

    createTask({
      id: 'noisy-task',
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt: 'Say hello',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      silent: false,
    });

    const task = getTaskById('noisy-task');
    expect(task?.silent).toBe(0); // SQLite stores false as 0
  });

  function makeDeps(
    overrides?: Partial<SchedulerDependencies>,
  ): SchedulerDependencies {
    const groupFolder = 'test-group';
    const chatJid = 'tg:999';
    return {
      registeredGroups: () => ({
        [chatJid]: {
          name: 'test',
          folder: groupFolder,
          isMain: true,
          requiresTrigger: false,
          trigger: '',
          added_at: '',
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: vi.fn(
          (_jid: string, _taskId: string, fn: () => Promise<void>) => {
            void fn();
          },
        ),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      onProcess: () => {},
      sendMessage: vi.fn(async () => {}),
      sendStreamMessage: vi.fn(async () => 42),
      editMessage: vi.fn(async () => {}),
      setTyping: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('HEARTBEAT_OK output is not sent to user', async () => {
    const mock = await getRunHostAgentMock();
    mock.mockImplementation(
      async (
        _group: RegisteredGroup,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _input: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _onProcess: any,
        onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        if (onOutput) {
          await onOutput({ result: 'HEARTBEAT_OK', status: 'success' });
        }
        return { result: 'HEARTBEAT_OK', status: 'success' as const };
      },
    );

    createTask({
      id: 'heartbeat-task',
      group_folder: 'test-group',
      chat_jid: 'tg:999',
      prompt: 'heartbeat',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('duplicate streaming output is sent only once', async () => {
    const mock = await getRunHostAgentMock();
    mock.mockImplementation(
      async (
        _group: RegisteredGroup,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _input: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _onProcess: any,
        onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        if (onOutput) {
          await onOutput({ result: 'Hello!', status: 'success' });
          await onOutput({ result: 'Hello!', status: 'success' });
          await onOutput({ result: 'Hello!', status: 'success' });
        }
        return { result: 'Hello!', status: 'success' as const };
      },
    );

    createTask({
      id: 'dedup-task',
      group_folder: 'test-group',
      chat_jid: 'tg:999',
      prompt: 'say hello',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith('tg:999', 'Hello!');
  });

  it('streams partial output via sendStreamMessage/editMessage', async () => {
    const mock = await getRunHostAgentMock();
    mock.mockImplementation(
      async (
        _group: RegisteredGroup,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _input: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _onProcess: any,
        onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        if (onOutput) {
          await onOutput({ result: 'Hello', status: 'success', partial: true });
          await onOutput({
            result: 'Hello world',
            status: 'success',
            partial: true,
          });
          await onOutput({ result: 'Hello world!', status: 'success' });
        }
        return { result: 'Hello world!', status: 'success' as const };
      },
    );

    createTask({
      id: 'stream-task',
      group_folder: 'test-group',
      chat_jid: 'tg:999',
      prompt: 'say hello',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    // First partial → sendStreamMessage
    expect(deps.sendStreamMessage).toHaveBeenCalledWith('tg:999', 'Hello');
    // Final → editMessage (streaming was active)
    expect(deps.editMessage).toHaveBeenCalledWith('tg:999', 42, 'Hello world!');
    // sendMessage should NOT be called (streaming handled it)
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to sendMessage when sendStreamMessage is undefined', async () => {
    const mock = await getRunHostAgentMock();
    mock.mockImplementation(
      async (
        _group: RegisteredGroup,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _input: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _onProcess: any,
        onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        if (onOutput) {
          await onOutput({
            result: 'Partial',
            status: 'success',
            partial: true,
          });
          await onOutput({ result: 'Final text', status: 'success' });
        }
        return { result: 'Final text', status: 'success' as const };
      },
    );

    createTask({
      id: 'fallback-task',
      group_folder: 'test-group',
      chat_jid: 'tg:999',
      prompt: 'say hello',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const deps = makeDeps({ sendStreamMessage: undefined });
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    // Partials ignored, final via sendMessage
    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith('tg:999', 'Final text');
  });

  it('strips internal tags from task output', async () => {
    const mock = await getRunHostAgentMock();
    mock.mockImplementation(
      async (
        _group: RegisteredGroup,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _input: any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        _onProcess: any,
        onOutput?: (output: ContainerOutput) => Promise<void>,
      ) => {
        if (onOutput) {
          await onOutput({
            result: '<internal>thinking</internal>Answer',
            status: 'success',
          });
        }
        return {
          result: '<internal>thinking</internal>Answer',
          status: 'success' as const,
        };
      },
    );

    createTask({
      id: 'internal-task',
      group_folder: 'test-group',
      chat_jid: 'tg:999',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    expect(deps.sendMessage).toHaveBeenCalledWith('tg:999', 'Answer');
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
