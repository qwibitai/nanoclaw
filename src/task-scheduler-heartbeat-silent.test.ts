import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./host-runner.js', () => ({
  runHostAgent: vi.fn(),
}));

vi.mock('./live-location.js', () => ({
  getActiveLiveLocationContext: vi.fn(() => ''),
}));

import type { ContainerOutput } from './container-runner.js';
import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  startSchedulerLoop,
  type SchedulerDependencies,
} from './task-scheduler.js';
import {
  getRunHostAgentMock,
  makeDeps,
} from './task-scheduler-test-harness.js';
import type { RegisteredGroup } from './types.js';

beforeEach(() => {
  _initTestDatabase();
  _resetSchedulerLoopForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('task scheduler — silent tasks', () => {
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

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('non-silent tasks store silent=0 in DB', async () => {
    createTask({
      id: 'noisy-task',
      group_folder: 'test-group',
      chat_jid: 'tg:456',
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
    expect(task?.silent).toBe(0);
  });
});

describe('task scheduler — HEARTBEAT_OK suppression', () => {
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

  it('HEARTBEAT_OK embedded in multi-turn text is suppressed', async () => {
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
            result: 'I sent the update.\n\nHEARTBEAT_OK',
            status: 'success',
          });
        }
        return {
          result: 'I sent the update.\n\nHEARTBEAT_OK',
          status: 'success' as const,
        };
      },
    );

    createTask({
      id: 'heartbeat-multi-turn',
      group_folder: 'test-group',
      chat_jid: 'tg:999',
      prompt: 'send update',
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
});
