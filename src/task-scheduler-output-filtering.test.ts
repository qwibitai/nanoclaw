import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./host-runner.js', () => ({
  runHostAgent: vi.fn(),
}));

vi.mock('./live-location.js', () => ({
  getActiveLiveLocationContext: vi.fn(() => ''),
}));

import type { ContainerOutput } from './container-runner.js';
import { _initTestDatabase, createTask } from './db.js';
import {
  _resetSchedulerLoopForTests,
  startSchedulerLoop,
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

describe('task scheduler — duplicate output dedup', () => {
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
});

describe('task scheduler — partial output handling', () => {
  it('ignores partial output and sends only the final result', async () => {
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

    expect(deps.sendMessage).toHaveBeenCalledTimes(1);
    expect(deps.sendMessage).toHaveBeenCalledWith('tg:999', 'Hello world!');
  });
});

describe('task scheduler — internal tag stripping', () => {
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
});
