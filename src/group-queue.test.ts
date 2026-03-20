import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
  MAX_CONTAINERS_PER_GROUP: 2,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Single group at a time (backward compat) ---

  it('only runs one container per thread at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group (same default thread)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    // Advance timers to let the first process complete
    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (global limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

    // Let promises settle
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should be active (MAX_CONCURRENT_CONTAINERS = 2)
    expect(maxActive).toBe(2);
    expect(activeCount).toBe(2);

    // Complete one — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);
  });

  // --- Tasks prioritized over messages ---

  it('drains tasks before messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (groupJid: string) => {
      if (executionOrder.length === 0) {
        // First call: block until we release it
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    queue.enqueueMessageCheck('group1@g.us');

    // Release the first processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    // Task should have run before the second message check
    expect(executionOrder[0]).toBe('messages'); // first call
    expect(executionOrder[1]).toBe('task'); // task runs first in drain
    // Messages would run after task completes
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens immediately
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms (BASE_RETRY_MS * 2^0)
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms (BASE_RETRY_MS * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // Run through all 5 retries (MAX_RETRIES = 5)
    // Initial call
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry 1: 5000ms, Retry 2: 10000ms, Retry 3: 20000ms, Retry 4: 40000ms, Retry 5: 80000ms
    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    // After 5 retries (6 total calls), should stop — no more retries
    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000); // Wait a long time
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both global slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Running task dedup (Issue #138) ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task (runs immediately — slot available)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate was NOT queued
    expect(dupFn).not.toHaveBeenCalled();

    // Complete the original task
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    // Only one execution total
    expect(taskCallCount).toBe(1);
  });

  // --- Idle preemption ---

  it('does NOT preempt active container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Enqueue a task while container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close should NOT have been written (container is working, not idle)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts idle container when task is enqueued', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    // _close SHOULD have been written (container is idle)
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // Container becomes idle
    queue.notifyIdle('group1@g.us');

    // A new user message arrives — resets idleWaiting
    queue.sendMessage('group1@g.us', 'hello');

    // Task enqueued after message reset — should NOT preempt (agent is working)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage returns false for task containers so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (sets isTaskContainer = true)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    // sendMessage should return false — user messages must not go to task containers
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('preempts when idle arrives with pending tasks', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and enqueue a task (no idle yet — no preemption)
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now container becomes idle — should preempt because task is pending
    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // =========================================================
  // New tests: multi-thread concurrency
  // =========================================================

  it('runs multiple containers per group up to per-group limit', async () => {
    const completionCallbacks: Array<() => void> = [];
    const activeThreadIds: string[] = [];
    let maxConcurrentPerGroup = 0;
    let currentPerGroup = 0;

    const processMessages = vi.fn(
      async (groupJid: string, threadId?: string) => {
        currentPerGroup++;
        maxConcurrentPerGroup = Math.max(
          maxConcurrentPerGroup,
          currentPerGroup,
        );
        activeThreadIds.push(threadId ?? 'default');
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        currentPerGroup--;
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two different threads for the same group (limit is 2)
    queue.enqueueThreadMessageCheck('group1@g.us', 'thread-A');
    queue.enqueueThreadMessageCheck('group1@g.us', 'thread-B');
    await vi.advanceTimersByTimeAsync(10);

    // Both should be active simultaneously
    expect(maxConcurrentPerGroup).toBe(2);
    expect(activeThreadIds).toContain('thread-A');
    expect(activeThreadIds).toContain('thread-B');

    completionCallbacks[0]();
    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('queues threads when per-group limit is reached', async () => {
    const completionCallbacks: Array<() => void> = [];
    const startOrder: string[] = [];

    const processMessages = vi.fn(
      async (groupJid: string, threadId?: string) => {
        startOrder.push(threadId ?? 'default');
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 threads but limit is 2
    queue.enqueueThreadMessageCheck('group1@g.us', 'thread-A');
    queue.enqueueThreadMessageCheck('group1@g.us', 'thread-B');
    queue.enqueueThreadMessageCheck('group1@g.us', 'thread-C');
    await vi.advanceTimersByTimeAsync(10);

    // Only 2 should have started
    expect(startOrder).toHaveLength(2);
    expect(startOrder).toContain('thread-A');
    expect(startOrder).toContain('thread-B');

    // Complete one — thread-C should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(startOrder).toHaveLength(3);
    expect(startOrder).toContain('thread-C');

    completionCallbacks[1]();
    completionCallbacks[2]();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('routes IPC messages to thread-specific paths', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueThreadMessageCheck('group1@g.us', 'thread-A');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'group-folder',
      'thread-A',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    // 3-arg form
    const result = queue.sendMessage('group1@g.us', 'thread-A', 'hello');
    expect(result).toBe(true);

    // Should have written to the thread-specific temp path
    const mkdirSync = vi.mocked(fs.default.mkdirSync);
    const mkdirCall = mkdirSync.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' && call[0].includes('/thread-A/input'),
    );
    expect(mkdirCall).toBeTruthy();

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('backward compat: enqueueMessageCheck still works with default threadId', async () => {
    const called: Array<[string, string | undefined]> = [];

    const processMessages = vi.fn(
      async (groupJid: string, threadId?: string) => {
        called.push([groupJid, threadId]);
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(called).toHaveLength(1);
    expect(called[0][0]).toBe('group1@g.us');
    expect(called[0][1]).toBe('default');
  });

  it('isActive returns false without threadId when no threads active', () => {
    expect(queue.isActive('group1@g.us')).toBe(false);
  });

  it('isActive with threadId returns true only for that thread', async () => {
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueThreadMessageCheck('group1@g.us', 'thread-A');
    await vi.advanceTimersByTimeAsync(10);

    // thread-A is active, thread-B is not
    expect(queue.isActive('group1@g.us', 'thread-A')).toBe(true);
    expect(queue.isActive('group1@g.us', 'thread-B')).toBe(false);

    // Without threadId — returns true because thread-A is active
    expect(queue.isActive('group1@g.us')).toBe(true);

    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('isActive returns false for task containers', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // isActive should be false even though there's an active task container
    expect(queue.isActive('group1@g.us')).toBe(false);
    expect(queue.isActive('group1@g.us', 'default')).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('drain logic: waiting threads processed after a thread completes', async () => {
    const completionCallbacks: Array<() => void> = [];
    const startOrder: string[] = [];

    const processMessages = vi.fn(
      async (groupJid: string, threadId?: string) => {
        startOrder.push(threadId ?? 'default');
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // Fill per-group limit (2) and global limit (2) simultaneously
    queue.enqueueThreadMessageCheck('group1@g.us', 'thread-A');
    queue.enqueueThreadMessageCheck('group1@g.us', 'thread-B');
    // thread-C has to wait for per-group slot
    queue.enqueueThreadMessageCheck('group1@g.us', 'thread-C');
    await vi.advanceTimersByTimeAsync(10);

    expect(startOrder).toHaveLength(2);

    // Complete thread-A — thread-C should start (per-group slot freed)
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(startOrder).toHaveLength(3);
    expect(startOrder[2]).toBe('thread-C');

    completionCallbacks[1]();
    completionCallbacks[2]();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('closeStdin writes to thread-specific path', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveProcess = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueThreadMessageCheck('group1@g.us', 'thread-A');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'group-folder',
      'thread-A',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    queue.closeStdin('group1@g.us', 'thread-A');

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('/thread-A/input/_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });
});
