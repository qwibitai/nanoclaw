/**
 * Integration: task scheduler → queue → mocked agent → result recorded
 *
 * Wires together real db, GroupQueue, and task-scheduler with a mocked
 * host-runner (so no actual container is spawned). Verifies the full
 * scheduled-task lifecycle: creation → polling → enqueue → execution →
 * result log + status update.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getAllRegisteredGroups,
  getTaskById,
  setRegisteredGroup,
} from '../../db.js';
import type { ContainerOutput } from '../../container-runner.js';
import { GroupQueue } from '../../group-queue.js';
import {
  _resetSchedulerLoopForTests,
  startSchedulerLoop,
  type SchedulerDependencies,
} from '../../task-scheduler.js';
import type { RegisteredGroup } from '../../types.js';

vi.mock('../../host-runner.js', () => ({
  runHostAgent: vi.fn(),
}));
vi.mock('../../live-location.js', () => ({
  getActiveLiveLocationContext: vi.fn(() => ''),
}));

async function getRunHostAgentMock() {
  const mod = await import('../../host-runner.js');
  return mod.runHostAgent as ReturnType<typeof vi.fn>;
}

describe('integration: scheduled task flow', () => {
  beforeEach(async () => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    const mock = await getRunHostAgentMock();
    mock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Flush any pending scheduler setTimeout(loop, ...) before swapping timers.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('due task is enqueued, executed, and recorded with success', async () => {
    const chatJid = 'tg:1001';
    const folder = 'test-folder';
    setRegisteredGroup(chatJid, {
      name: 'Test',
      folder,
      trigger: '',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
      requiresTrigger: false,
    });

    createTask({
      id: 'due-task',
      group_folder: folder,
      chat_jid: chatJid,
      prompt: 'run once',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      silent: false,
    });

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
          await onOutput({ status: 'success', result: 'task done' });
        }
        return { status: 'success' as const, result: 'task done' };
      },
    );

    const sendMessage = vi.fn(async () => {});
    const queue = new GroupQueue();

    const deps: SchedulerDependencies = {
      registeredGroups: () => getAllRegisteredGroups(),
      getSessions: () => ({}),
      queue,
      onProcess: () => {},
      sendMessage,
    };

    startSchedulerLoop(deps);
    // Let the scheduler initial tick run, then allow runTask to progress.
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(30_000); // past TASK_CLOSE_DELAY_MS(10s)+TASK_KILL_GRACE_MS(15s)

    // 'once' tasks are deleted after completion.
    expect(getTaskById('due-task')).toBeUndefined();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(chatJid, 'task done');
  });

  it('silent task does not call sendMessage', async () => {
    const chatJid = 'tg:2002';
    const folder = 'silent-folder';
    setRegisteredGroup(chatJid, {
      name: 'Silent',
      folder,
      trigger: '',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain: true,
      requiresTrigger: false,
    });

    createTask({
      id: 'silent-task',
      group_folder: folder,
      chat_jid: chatJid,
      prompt: 'silent cron',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      silent: true,
    });

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
          await onOutput({ status: 'success', result: 'quiet ok' });
        }
        return { status: 'success' as const, result: 'quiet ok' };
      },
    );

    const sendMessage = vi.fn(async () => {});
    const queue = new GroupQueue();

    startSchedulerLoop({
      registeredGroups: () => getAllRegisteredGroups(),
      getSessions: () => ({}),
      queue,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(getTaskById('silent-task')).toBeUndefined();
    expect(mock).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('invalid group folder path pauses the task (no retry churn)', async () => {
    createTask({
      id: 'bad-folder',
      group_folder: '../../outside',
      chat_jid: 'tg:9999',
      prompt: 'escape',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const queue = new GroupQueue();
    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue,
      onProcess: () => {},
      sendMessage: async () => {},
    });
    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('bad-folder');
    expect(task?.status).toBe('paused');
  });
});
