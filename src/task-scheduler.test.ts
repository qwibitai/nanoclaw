import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runContainerAgent: vi.fn(),
    writeTasksSnapshot: vi.fn(),
  };
});

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi
    .fn()
    .mockReturnValue('/tmp/nanoclaw-test/groups/main'),
  resolveGroupIpcPath: vi.fn().mockReturnValue('/tmp/nanoclaw-test/ipc/main'),
}));

import fs from 'fs';
import { _initTestDatabase, createTask as dbCreateTask } from './db/index.js';
import { computeNextRun, runScheduledTask } from './task-scheduler.js';
import { runContainerAgent } from './container-runner.js';
import type { SchedulerDependencies } from './task-scheduler.js';
import type { ScheduledTask } from './types.js';
import type { GroupQueue } from './group-queue.js';

let taskCounter = 0;

/** Create a ScheduledTask and insert it into the test DB (for FK constraints). */
function makeTask(overrides?: Partial<ScheduledTask>): ScheduledTask {
  const now = new Date().toISOString();
  const task: ScheduledTask = {
    id: `test-task-${++taskCounter}`,
    group_folder: 'main',
    chat_jid: 'ceo@g.us',
    prompt: 'Check the weather',
    schedule_type: 'once',
    schedule_value: now,
    context_mode: 'isolated',
    next_run: now,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
  // Insert into test DB so logTaskRun FK constraint is satisfied
  dbCreateTask({
    id: task.id,
    group_folder: task.group_folder,
    chat_jid: task.chat_jid,
    prompt: task.prompt,
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    context_mode: task.context_mode,
    next_run: task.next_run,
    status: task.status,
    created_at: task.created_at,
  });
  return task;
}

function makeDeps(
  overrides?: Partial<SchedulerDependencies>,
): SchedulerDependencies {
  return {
    registeredGroups: () => ({
      'ceo@g.us': {
        name: 'CEO',
        folder: 'main',
        trigger: '',
        added_at: '2026-01-01T00:00:00Z',
        isMain: true,
      },
    }),
    getSessions: () => ({}),
    queue: {
      enqueueTask: vi.fn(),
      registerProcess: vi.fn(),
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
      shutdown: vi.fn(),
    } as unknown as GroupQueue,
    onProcess: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.useFakeTimers();
    // Ensure the mock group directory exists
    fs.mkdirSync('/tmp/nanoclaw-test/groups/main/logs', { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  describe('/orchestrate routing suppression', () => {
    it('sends result to chat for normal scheduled tasks', async () => {
      const task = makeTask({ prompt: 'Check the weather' });
      const deps = makeDeps();

      vi.mocked(runContainerAgent).mockImplementation(
        async (_group, _input, _onProcess, onOutput) => {
          await onOutput?.({ status: 'success', result: 'Sunny today!' });
          return { status: 'success', result: 'Sunny today!' };
        },
      );

      await runScheduledTask(task, deps);

      expect(deps.sendMessage).toHaveBeenCalledWith('ceo@g.us', 'Sunny today!');
    });

    it('suppresses result sendMessage for /orchestrate tasks', async () => {
      const task = makeTask({
        prompt: '/orchestrate Fix login bug\n\nUsers cannot log in',
      });
      const deps = makeDeps();

      vi.mocked(runContainerAgent).mockImplementation(
        async (_group, _input, _onProcess, onOutput) => {
          await onOutput?.({
            status: 'success',
            result: 'Task dispatched to sub-agent',
          });
          return { status: 'success', result: 'Task dispatched to sub-agent' };
        },
      );

      await runScheduledTask(task, deps);

      // sendMessage should NOT have been called — /orchestrate results stay internal
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('suppresses error alerts for /orchestrate tasks', async () => {
      const task = makeTask({
        prompt: '/orchestrate Deploy new service\n\nDeploy the service',
      });
      const deps = makeDeps();

      vi.mocked(runContainerAgent).mockImplementation(
        async (_group, _input, _onProcess, onOutput) => {
          await onOutput?.({
            status: 'error',
            result: null,
            error: 'Container crashed',
          });
          return { status: 'error', result: null, error: 'Container crashed' };
        },
      );

      await runScheduledTask(task, deps);

      // Error alerts should NOT be sent to CEO chat for /orchestrate tasks
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('sends error alerts for non-orchestrate tasks', async () => {
      const task = makeTask({ prompt: 'Run weekly report' });
      const deps = makeDeps();

      vi.mocked(runContainerAgent).mockImplementation(
        async (_group, _input, _onProcess, onOutput) => {
          await onOutput?.({
            status: 'error',
            result: null,
            error: 'Report generation failed',
          });
          return {
            status: 'error',
            result: null,
            error: 'Report generation failed',
          };
        },
      );

      await runScheduledTask(task, deps);

      // Error alerts SHOULD be sent for regular tasks
      expect(deps.sendMessage).toHaveBeenCalled();
      const call = vi.mocked(deps.sendMessage).mock.calls[0];
      expect(call[1]).toContain('Scheduled task failed');
    });

    it('still returns result for /orchestrate tasks (for dispatch loop write-back)', async () => {
      const task = makeTask({
        prompt: '/orchestrate Implement feature X\n\nBuild feature X',
      });
      const deps = makeDeps();

      vi.mocked(runContainerAgent).mockImplementation(
        async (_group, _input, _onProcess, onOutput) => {
          await onOutput?.({
            status: 'success',
            result: 'Feature X implemented successfully',
          });
          return {
            status: 'success',
            result: 'Feature X implemented successfully',
          };
        },
      );

      const taskResult = await runScheduledTask(task, deps);

      // Result should still be captured for the dispatch loop to write back to Agency HQ
      expect(taskResult.result).toBe('Feature X implemented successfully');
      expect(taskResult.error).toBeNull();
      // But not sent to the CEO chat
      expect(deps.sendMessage).not.toHaveBeenCalled();
    });

    it('does not suppress messages for prompts containing /orchestrate mid-text', async () => {
      const task = makeTask({
        prompt: 'Please review the /orchestrate command documentation',
      });
      const deps = makeDeps();

      vi.mocked(runContainerAgent).mockImplementation(
        async (_group, _input, _onProcess, onOutput) => {
          await onOutput?.({
            status: 'success',
            result: 'Documentation reviewed',
          });
          return { status: 'success', result: 'Documentation reviewed' };
        },
      );

      await runScheduledTask(task, deps);

      // Should send — the prompt doesn't START with /orchestrate
      expect(deps.sendMessage).toHaveBeenCalledWith(
        'ceo@g.us',
        'Documentation reviewed',
      );
    });
  });
});
