import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./host-runner.js', () => ({
  runHostAgent: vi.fn(),
}));

vi.mock('./live-location.js', () => ({
  getActiveLiveLocationContext: vi.fn(() => ''),
}));

import type { ContainerOutput } from './container-runner.js';
import { _initTestDatabase, createTask } from './db.js';
import { getActiveLiveLocationContext } from './live-location.js';
import {
  _resetSchedulerLoopForTests,
  startSchedulerLoop,
} from './task-scheduler.js';
import { getRunHostAgentMock } from './task-scheduler-test-harness.js';
import type { RegisteredGroup } from './types.js';

beforeEach(() => {
  _initTestDatabase();
  _resetSchedulerLoopForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('task scheduler — live location context', () => {
  it('prepends live location context for group context_mode tasks', async () => {
    const locationPrefix =
      '[Live location sharing enabled] lat: 35, long: 139. check `tail /path/to/log`\n';
    vi.mocked(getActiveLiveLocationContext).mockReturnValue(locationPrefix);

    const groupFolder = 'test-group';
    const chatJid = 'tg:100200300';

    createTask({
      id: 'task-group-ctx',
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt: 'summarize what happened',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const runHostAgentMock = await getRunHostAgentMock();
    runHostAgentMock.mockImplementation(
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

    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop({
      registeredGroups: () => ({
        [chatJid]: {
          name: 'Test',
          folder: groupFolder,
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
        } as RegisteredGroup,
      }),
      getSessions: () => ({ [groupFolder]: 'session-abc' }),
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
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(runHostAgentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        prompt: locationPrefix + 'summarize what happened',
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('isolated task prompt is not affected by live location context', async () => {
    vi.mocked(getActiveLiveLocationContext).mockReturnValue(
      '[Live location sharing enabled] lat: 35, long: 139\n',
    );

    const groupFolder = 'test-group';
    const chatJid = 'tg:100200300';

    createTask({
      id: 'task-isolated',
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    const runHostAgentMock = await getRunHostAgentMock();
    runHostAgentMock.mockImplementation(
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

    startSchedulerLoop({
      registeredGroups: () => ({
        [chatJid]: {
          name: 'Test',
          folder: groupFolder,
          trigger: '@Andy',
          added_at: '2026-01-01T00:00:00.000Z',
        } as RegisteredGroup,
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
      sendMessage: vi.fn(async () => {}),
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(runHostAgentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prompt: 'do something' }),
      expect.anything(),
      expect.anything(),
    );
  });
});
