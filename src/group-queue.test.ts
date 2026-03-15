import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
  MAX_THREADS_PER_GROUP: 3,
  GROUP_THREAD_KEY: '__group__',
}));

// Mock group-folder to avoid real path resolution
vi.mock('./group-folder.js', () => ({
  resolveGroupIpcInputPath: (folder: string, threadId: string) =>
    `/tmp/nanoclaw-test-data/ipc/${folder}/input/${threadId}`,
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

  // --- Single group at a time (non-threaded) ---

  it('only runs one container per group at a time for non-threaded channels', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async (groupJid: string) => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group (no threadId = GROUP_THREAD_KEY)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    await vi.advanceTimersByTimeAsync(200);

    // Second enqueue should have been queued, not concurrent
    expect(maxConcurrent).toBe(1);
  });

  // --- Per-thread concurrency ---

  it('runs concurrent containers for different threads in same group', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (jid: string) => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 messages for different threads in the same group
    queue.enqueueMessageCheck('dc:parent', 'dc:parent:thread:t1', 't1');
    queue.enqueueMessageCheck('dc:parent', 'dc:parent:thread:t2', 't2');
    queue.enqueueMessageCheck('dc:parent', 'dc:parent:thread:t3', 't3');

    await vi.advanceTimersByTimeAsync(10);

    // All 3 should be active (MAX_THREADS_PER_GROUP = 3, MAX_CONCURRENT = 2
    // but we have 2 global slots... so only 2 should run)
    expect(maxActive).toBe(2);

    // Complete first — third should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);

    // Cleanup
    completionCallbacks[1]();
    completionCallbacks[2]();
    await vi.advanceTimersByTimeAsync(10);
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

    // Enqueue 3 groups (limit is 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');

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

    expect(executionOrder[0]).toBe('messages');
    expect(executionOrder[1]).toBe('task');
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  it('retries with thread processJid preserved', async () => {
    const processed: string[] = [];

    const processMessages = vi.fn(async (jid: string) => {
      processed.push(jid);
      return false;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('dc:parent', 'dc:parent:thread:t1', 't1');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['dc:parent:thread:t1']);

    // After retry delay, should use the thread JID
    await vi.advanceTimersByTimeAsync(5010);
    expect(processed).toEqual(['dc:parent:thread:t1', 'dc:parent:thread:t1']);
  });

  // --- Shutdown ---

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
      return false;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000);
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups drained ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots
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

  // --- Running task dedup ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    expect(dupFn).not.toHaveBeenCalled();

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

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

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us',
      undefined,
      {} as any,
      'container-1',
      'test-group',
    );

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

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

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us',
      undefined,
      {} as any,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('sendMessage resets idleWaiting so subsequent task enqueue does not preempt', async () => {
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
      undefined,
      {} as any,
      'container-1',
      'test-group',
    );

    queue.notifyIdle('group1@g.us');

    // sendMessage with threadId=undefined (GROUP_THREAD_KEY)
    queue.sendMessage('group1@g.us', undefined, 'hello');

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

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      undefined,
      {} as any,
      'container-1',
      'test-group',
    );

    const result = queue.sendMessage('group1@g.us', undefined, 'hello');
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

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us',
      undefined,
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

    writeFileSync.mockClear();
    queue.notifyIdle('group1@g.us');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- processJid routing ---

  it('passes processJid (not groupJid) to processMessagesFn', async () => {
    const processed: string[] = [];

    const processMessages = vi.fn(async (jid: string) => {
      processed.push(jid);
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('dc:parent', 'dc:parent:thread:t1', 't1');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['dc:parent:thread:t1']);
  });

  it('defaults processJid to groupJid when not provided', async () => {
    const processed: string[] = [];

    const processMessages = vi.fn(async (jid: string) => {
      processed.push(jid);
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('dc:parent');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['dc:parent']);
  });

  it('isThreadActive returns true for active thread, false otherwise', async () => {
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('dc:parent', 'dc:parent:thread:t1', 't1');
    await vi.advanceTimersByTimeAsync(10);

    expect(queue.isThreadActive('dc:parent', 't1')).toBe(true);
    expect(queue.isThreadActive('dc:parent', 't2')).toBe(false);
    expect(queue.isThreadActive('dc:parent', undefined)).toBe(false);

    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('deduplicates same processJid enqueued multiple times', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (jid: string) => {
      processed.push(jid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('dc:parent', 'dc:parent:thread:t1', 't1');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue same processJid twice while active
    queue.enqueueMessageCheck('dc:parent', 'dc:parent:thread:t2', 't2');
    queue.enqueueMessageCheck('dc:parent', 'dc:parent:thread:t2', 't2');

    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['dc:parent:thread:t1', 'dc:parent:thread:t2']);
    expect(processMessages).toHaveBeenCalledTimes(2);
  });

  it('cleans up reassigned thread slot after completion', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (jid: string) => {
      processed.push(jid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start with GROUP_THREAD_KEY (top-level message on thread-enabled channel)
    queue.enqueueMessageCheck('slack:C123');
    await vi.advanceTimersByTimeAsync(10);

    expect(queue.isThreadActive('slack:C123', undefined)).toBe(true);

    // Simulate processGroupMessages reassigning to effectiveThreadId
    queue.reassignThreadKey('slack:C123', '__group__', 'thread-abc');

    // GROUP_THREAD_KEY should be free, thread-abc should be active
    expect(queue.isThreadActive('slack:C123', undefined)).toBe(false);
    expect(queue.isThreadActive('slack:C123', 'thread-abc')).toBe(true);

    // Complete the container
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    // After completion, the reassigned thread slot must be cleaned up
    expect(queue.isThreadActive('slack:C123', 'thread-abc')).toBe(false);
    expect(queue.isActive('slack:C123')).toBe(false);

    // New message for the same thread should start immediately (not get stuck)
    queue.enqueueMessageCheck('slack:C123', 'slack:C123:thread:thread-abc', 'thread-abc');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toHaveLength(2);
    expect(processed[1]).toBe('slack:C123:thread:thread-abc');

    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('drainWaiting processes pendingProcessJids for waiting groups', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (jid: string) => {
      processed.push(jid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots (MAX_CONCURRENT_CONTAINERS = 2)
    queue.enqueueMessageCheck('group1@g.us', 'group1@g.us:thread:t1', 't1');
    queue.enqueueMessageCheck('group2@g.us', 'group2@g.us:thread:t2', 't2');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual([
      'group1@g.us:thread:t1',
      'group2@g.us:thread:t2',
    ]);

    // At concurrency limit — this goes to waitingGroups
    queue.enqueueMessageCheck('group3@g.us', 'group3@g.us:thread:t3', 't3');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toHaveLength(2);

    // Free a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us:thread:t3');

    // Cleanup
    completionCallbacks[1]();
    completionCallbacks[2]();
    await vi.advanceTimersByTimeAsync(10);
  });
});
