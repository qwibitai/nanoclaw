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

describe('task scheduler — one-shot deletion', () => {
  it('deletes completed one-shot task after execution', async () => {
    const mock = await getRunHostAgentMock();
    mock.mockImplementation(
      async (
        _group: unknown,
        _opts: unknown,
        _onProcess: unknown,
        onOutput: (o: ContainerOutput) => Promise<void>,
      ) => {
        await onOutput({ result: 'done', status: 'success' });
        return { result: 'done', status: 'success' as const };
      },
    );

    createTask({
      id: 'one-shot-delete',
      group_folder: 'test-group',
      chat_jid: 'tg:999',
      prompt: 'run once',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    expect(getTaskById('one-shot-delete')).toBeDefined();

    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(100);

    expect(getTaskById('one-shot-delete')).toBeUndefined();
  });
});

describe('task scheduler — thinking_budget propagation', () => {
  it('passes thinking_budget through to the agent runner', async () => {
    const mock = await getRunHostAgentMock();
    mock.mockImplementation(
      async (
        _group: unknown,
        _opts: unknown,
        _onProcess: unknown,
        onOutput: (o: ContainerOutput) => Promise<void>,
      ) => {
        await onOutput({ result: 'done', status: 'success' });
        return { result: 'done', status: 'success' as const };
      },
    );

    createTask({
      id: 'tb-task',
      group_folder: 'test-group',
      chat_jid: 'tg:999',
      prompt: 'think hard',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      thinking_budget: 'high',
    });

    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(100);

    expect(mock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ thinking_budget: 'high' }),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('task scheduler — agent force-kill', () => {
  it('force-kills agent if it does not exit after _close grace period', async () => {
    const mock = await getRunHostAgentMock();

    let resolveAgent: (() => void) | undefined;
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
        await new Promise<void>((resolve) => {
          resolveAgent = resolve;
        });
        return { result: null, status: 'success' as const };
      },
    );

    createTask({
      id: 'kill-fallback-task',
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

    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.queue.closeStdin).toHaveBeenCalledWith('tg:999');
    expect(deps.queue.killProcess).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(deps.queue.killProcess).toHaveBeenCalledWith('tg:999');

    resolveAgent?.();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('does not force-kill when agent exits normally before grace period', async () => {
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
      id: 'no-kill-task',
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

    await vi.advanceTimersByTimeAsync(30_000);

    expect(deps.queue.killProcess).not.toHaveBeenCalled();
  });

  it('compact_boundary does not trigger scheduleClose (agent still working)', async () => {
    const mock = await getRunHostAgentMock();

    let resolveAgent: (() => void) | undefined;
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
            result: null,
            status: 'success',
            compacted: true,
          });
          await new Promise<void>((r) => setTimeout(r, 30_000));
          await onOutput({
            result: 'Done after compaction',
            status: 'success',
          });
        }
        await new Promise<void>((resolve) => {
          resolveAgent = resolve;
        });
        return { result: null, status: 'success' as const };
      },
    );

    createTask({
      id: 'compact-task',
      group_folder: 'test-group',
      chat_jid: 'tg:999',
      prompt: 'long task',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const deps = makeDeps();
    startSchedulerLoop(deps);
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(deps.queue.closeStdin).not.toHaveBeenCalled();
    expect(deps.queue.killProcess).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(deps.queue.closeStdin).toHaveBeenCalledWith('tg:999');

    resolveAgent?.();
    await vi.advanceTimersByTimeAsync(10);
  });
});
