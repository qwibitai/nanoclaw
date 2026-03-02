import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  startSchedulerLoop,
} from './task-scheduler.js';

// Mock memory module
vi.mock('./memory.js', () => ({
  retrieveMemoryContext: vi.fn().mockResolvedValue('<memory>test context</memory>\n\n'),
  buildMemorySnapshot: vi.fn().mockReturnValue({ coreMemories: [] }),
}));

// Mock container-runner to capture the prompt passed to runContainerAgent
vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn().mockResolvedValue({
    status: 'success',
    result: 'task done',
    newSessionId: undefined,
  }),
  writeTasksSnapshot: vi.fn(),
}));

// Mock fs.mkdirSync and fs.writeFileSync to avoid filesystem side effects
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
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
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('injects memory context and snapshot into scheduled task prompt', async () => {
    const { retrieveMemoryContext, buildMemorySnapshot } = await import(
      './memory.js'
    );
    const { runContainerAgent } = await import('./container-runner.js');

    createTask({
      id: 'task-with-memory',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'summarize recent conversations',
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
      registeredGroups: () => ({
        'test@g.us': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@bot',
          added_at: '2026-01-01T00:00:00.000Z',
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask, closeStdin: vi.fn(), notifyIdle: vi.fn() } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    // Memory context was retrieved using the task prompt
    expect(retrieveMemoryContext).toHaveBeenCalledWith('test-group', [
      expect.objectContaining({ content: 'summarize recent conversations' }),
    ]);

    // Memory snapshot was built for the group
    expect(buildMemorySnapshot).toHaveBeenCalledWith('test-group');

    // Container agent received the memory-enriched prompt
    expect(runContainerAgent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        prompt: '<memory>test context</memory>\n\nsummarize recent conversations',
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });
});
