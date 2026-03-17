import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { DownloadTracker } from './download-tracker.js';
import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
  COALESCE_MS: 0,
  MAX_DOWNLOAD_WAIT_MS: 60000,
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

  // --- Single group at a time ---

  it('only runs one container per group at a time', async () => {
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

    // Enqueue two messages for the same group
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

    // Enqueue 3 groups (limit is 2)
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
});

/**
 * INVARIANT: When coalescing is enabled, container start is deferred by
 * coalesceMs and extended by pending downloads, so all content is available
 * in a single agent turn.
 * SUT: GroupQueue with coalesceMs > 0 and DownloadTracker
 * VERIFICATION: Fake timers control timing; processMessagesFn tracks calls.
 */
describe('GroupQueue coalescing + download tracking', () => {
  let queue: GroupQueue;
  let tracker: DownloadTracker;
  let processMessages: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new DownloadTracker();
    // coalesceMs=500, maxDownloadWaitMs=5000
    queue = new GroupQueue(500, 5000);
    queue.setDownloadTracker(tracker);

    processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(
      processMessages as (groupJid: string) => Promise<boolean>,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers container start by coalesceMs', async () => {
    queue.enqueueMessageCheck('g1');

    // Not started yet at 499ms
    await vi.advanceTimersByTimeAsync(499);
    expect(processMessages).not.toHaveBeenCalled();

    // Started at 500ms
    await vi.advanceTimersByTimeAsync(1);
    expect(processMessages).toHaveBeenCalledTimes(1);
  });

  it('absorbs multiple enqueues during coalesce window', async () => {
    queue.enqueueMessageCheck('g1');
    await vi.advanceTimersByTimeAsync(200);
    queue.enqueueMessageCheck('g1');
    await vi.advanceTimersByTimeAsync(200);
    queue.enqueueMessageCheck('g1');

    // Only one container start at 500ms from first enqueue
    await vi.advanceTimersByTimeAsync(100);
    expect(processMessages).toHaveBeenCalledTimes(1);
  });

  it('waits for pending downloads after coalesce window', async () => {
    // Simulate: text arrives, download starts at T=200ms
    queue.enqueueMessageCheck('g1');
    await vi.advanceTimersByTimeAsync(200);
    tracker.start('g1', 'doc-1');

    // Coalesce window ends at T=500ms — but download is pending
    await vi.advanceTimersByTimeAsync(300);
    expect(processMessages).not.toHaveBeenCalled();

    // Download completes at T=800ms — container starts
    tracker.complete('g1', 'doc-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(processMessages).toHaveBeenCalledTimes(1);
  });

  it('starts container when download times out', async () => {
    queue.enqueueMessageCheck('g1');
    tracker.start('g1', 'doc-1');

    // Coalesce window (500ms) + download wait timeout (5000ms) = 5500ms
    await vi.advanceTimersByTimeAsync(5499);
    expect(processMessages).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(processMessages).toHaveBeenCalledTimes(1);
  });

  it('starts immediately when no downloads pending and coalesce expires', async () => {
    queue.enqueueMessageCheck('g1');

    await vi.advanceTimersByTimeAsync(500);
    expect(processMessages).toHaveBeenCalledTimes(1);
  });

  it('does not delay messages to active containers', async () => {
    // Start a container
    let resolveProcess: () => void;
    processMessages.mockImplementation(
      async () =>
        new Promise<boolean>((resolve) => {
          resolveProcess = () => resolve(true);
        }),
    );

    queue.enqueueMessageCheck('g1');
    await vi.advanceTimersByTimeAsync(500);
    expect(processMessages).toHaveBeenCalledTimes(1);

    // Register process and send message — should go through IPC immediately
    queue.registerProcess('g1', {} as any, 'container-1', 'test-group');
    queue.enqueueMessageCheck('g1');

    // The second enqueue should just set pendingMessages, no delay
    await vi.advanceTimersByTimeAsync(0);
    expect(processMessages).toHaveBeenCalledTimes(1); // Still just the first call

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('shutdown cancels pending coalesce timers', async () => {
    queue.enqueueMessageCheck('g1');

    await vi.advanceTimersByTimeAsync(200);
    await queue.shutdown(1000);

    await vi.advanceTimersByTimeAsync(500);
    expect(processMessages).not.toHaveBeenCalled();
  });

  it('E2E: text at T=0, download starts T=300, completes T=2000 — container starts at T=2000', async () => {
    // T=0: text message arrives
    queue.enqueueMessageCheck('g1');

    // T=300: document webhook arrives, download starts
    await vi.advanceTimersByTimeAsync(300);
    tracker.start('g1', 'doc-42');

    // T=500: coalesce window ends, but download pending
    await vi.advanceTimersByTimeAsync(200);
    expect(processMessages).not.toHaveBeenCalled();

    // T=1000: still downloading
    await vi.advanceTimersByTimeAsync(500);
    expect(processMessages).not.toHaveBeenCalled();

    // T=2000: download completes
    await vi.advanceTimersByTimeAsync(1000);
    tracker.complete('g1', 'doc-42');
    await vi.advanceTimersByTimeAsync(0);

    expect(processMessages).toHaveBeenCalledTimes(1);
  });

  it('handles multiple concurrent downloads for same chat', async () => {
    queue.enqueueMessageCheck('g1');
    tracker.start('g1', 'photo-1');
    tracker.start('g1', 'doc-1');

    await vi.advanceTimersByTimeAsync(500);
    expect(processMessages).not.toHaveBeenCalled();

    // Complete photo — doc still pending
    tracker.complete('g1', 'photo-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(processMessages).not.toHaveBeenCalled();

    // Complete doc — all done, container starts
    tracker.complete('g1', 'doc-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(processMessages).toHaveBeenCalledTimes(1);
  });

  it('independent chats coalesce independently', async () => {
    queue.enqueueMessageCheck('g1');
    queue.enqueueMessageCheck('g2');

    await vi.advanceTimersByTimeAsync(500);
    expect(processMessages).toHaveBeenCalledTimes(2);
    expect(processMessages).toHaveBeenCalledWith('g1');
    expect(processMessages).toHaveBeenCalledWith('g2');
  });

  it('coalesce window resets for subsequent messages after container finishes', async () => {
    queue.enqueueMessageCheck('g1');
    await vi.advanceTimersByTimeAsync(500);
    expect(processMessages).toHaveBeenCalledTimes(1);

    // Wait for container to finish
    await vi.advanceTimersByTimeAsync(10);

    // New message should start a fresh coalesce window
    queue.enqueueMessageCheck('g1');
    await vi.advanceTimersByTimeAsync(499);
    expect(processMessages).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(processMessages).toHaveBeenCalledTimes(2);
  });
});
