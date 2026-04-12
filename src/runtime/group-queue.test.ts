import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('../core/config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
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

    const processMessages = vi.fn(async (_groupJid: string) => {
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

    const processMessages = vi.fn(async (_groupJid: string) => {
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

    const processMessages = vi.fn(async (_groupJid: string) => {
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

  // --- Coverage for drainGroup line 230 ---

  it('drainGroup triggers after runForGroup completes', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(async (_groupJid: string) => {
      if (executionOrder.length === 0) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start first message processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a second message while first is active
    queue.enqueueMessageCheck('group1@g.us');

    // Complete first — drainGroup should trigger second run
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);

    expect(executionOrder.length).toBeGreaterThanOrEqual(2);
    expect(executionOrder[1]).toBe('messages');
  });

  // --- Coverage for drainWaiting with messages (line 337) ---

  it('drainWaiting runs pending messages for waiting groups when slots free up', async () => {
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

    // Queue messages for group3 (goes to waiting)
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Complete group1 — group3 should drain via drainWaiting with messages path
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // --- Coverage for drainWaiting with tasks (line 337 task path) ---

  it('drainWaiting runs pending tasks for waiting groups when slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots with messages
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue a task for group3 — will go to waiting list
    const taskExecuted = vi.fn();
    queue.enqueueTask('group3@g.us', 'task-waiting', async () => {
      taskExecuted();
    });
    await vi.advanceTimersByTimeAsync(10);

    // Task should not have run yet
    expect(taskExecuted).not.toHaveBeenCalled();

    // Complete group1 — group3's task should drain
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(taskExecuted).toHaveBeenCalledTimes(1);
  });

  // --- Coverage for shutdown with active processes (lines 355-356) ---

  it('shutdown logs active containers and detaches them', async () => {
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

    // Register a process with containerName (like a real container)
    const mockProcess = { killed: false } as any;
    queue.registerProcess('group1@g.us', mockProcess, 'container-active', 'team');

    // Shutdown should complete without killing the process
    await queue.shutdown(5000);

    // The process should still not be killed (detached)
    expect(mockProcess.killed).toBe(false);

    // After shutdown, new enqueues should be ignored
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(100);
    expect(processMessages).toHaveBeenCalledTimes(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Coverage for runTask error handling ---

  it('runTask handles task function errors without crashing', async () => {
    const taskFn = vi.fn(async () => {
      throw new Error('task execution failure');
    });

    queue.enqueueTask('group1@g.us', 'task-error', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Task should have been called and error should be caught
    expect(taskFn).toHaveBeenCalledTimes(1);

    // Queue should recover — enqueue another task for the same group
    const secondTaskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-recover', secondTaskFn);
    await vi.advanceTimersByTimeAsync(10);

    expect(secondTaskFn).toHaveBeenCalledTimes(1);
  });

  // --- Coverage for runForGroup error handling in processMessagesFn ---

  it('schedules retry when processMessagesFn throws', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('processing crash');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call throws
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Retry should occur after BASE_RETRY_MS
    await vi.advanceTimersByTimeAsync(5010);
    expect(callCount).toBe(2);
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

  // --- Coverage for sendMessage returning false when not active ---

  it('sendMessage returns false when no container is active for the group', () => {
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);
  });

  it('sendMessage returns false when active but no groupFolder registered', async () => {
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

    // Active but no registerProcess called (no groupFolder)
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Coverage for closeStdin when not active ---

  it('closeStdin does nothing when no container is active', async () => {
    const fs = await import('fs');
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    queue.closeStdin('group1@g.us');

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);
  });

  // --- Coverage for enqueueTask when shuttingDown ---

  it('enqueueTask does nothing after shutdown', async () => {
    const taskFn = vi.fn(async () => {});

    await queue.shutdown(1000);
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(100);

    expect(taskFn).not.toHaveBeenCalled();
  });

  // --- Coverage for drainWaiting skipping group with neither tasks nor messages ---

  it('drainWaiting skips waiting groups with no pending tasks or messages', async () => {
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

    // Enqueue group3 with messages (goes to waiting)
    queue.enqueueMessageCheck('group3@g.us');
    // Also enqueue group4 with messages
    queue.enqueueMessageCheck('group4@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Complete both active groups
    completionCallbacks[0]();
    completionCallbacks[1]();
    await vi.advanceTimersByTimeAsync(10);

    // Both group3 and group4 should eventually be processed
    expect(processed).toContain('group3@g.us');
    expect(processed).toContain('group4@g.us');
  });

  // --- Coverage for drainGroup when shuttingDown ---

  it('drainGroup does not drain after shutdown', async () => {
    let resolveProcess: () => void;
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          resolveProcess = resolve;
        });
      }
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start first group processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a second message while first is active
    queue.enqueueMessageCheck('group1@g.us');

    // Shutdown while first is still running
    await queue.shutdown(1000);

    // Complete first — drainGroup should see shuttingDown and skip
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);

    // Only the first call should have happened; drain should not fire the second
    expect(callCount).toBe(1);
  });

  // --- Coverage for duplicate task already queued ---

  it('rejects duplicate enqueue of an already-queued task', async () => {
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

    // Enqueue task while active
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-dup', taskFn);

    // Try to enqueue the same task again
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-dup', dupFn);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);

    // Original task should have run, duplicate should not
    expect(taskFn).toHaveBeenCalledTimes(1);
    expect(dupFn).not.toHaveBeenCalled();
  });

  // --- Coverage for retry timeout not firing after shutdown ---

  it('retry timer does not fire after shutdown', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    // First call happens
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // Shutdown before retry fires
    await queue.shutdown(1000);

    // Advance past retry delay
    await vi.advanceTimersByTimeAsync(10000);

    // Should not have retried after shutdown
    expect(callCount).toBe(1);
  });

  // --- Coverage for enqueueTask at concurrency limit ---

  it('enqueueTask queues task when at concurrency limit', async () => {
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots with messages
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue a task for a new group at the concurrency limit
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group3@g.us', 'task-limit', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Task should not have run yet
    expect(taskFn).not.toHaveBeenCalled();

    // Free a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    // Now the task should run
    expect(taskFn).toHaveBeenCalledTimes(1);
  });

  // --- Coverage for sendMessage success path ---

  it('sendMessage returns true and writes IPC file for active message container', async () => {
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

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const renameSync = vi.mocked(fs.default.renameSync);
    writeFileSync.mockClear();
    renameSync.mockClear();

    const result = queue.sendMessage('group1@g.us', 'hello world');
    expect(result).toBe(true);

    // Should have written a temp file and renamed it
    expect(writeFileSync).toHaveBeenCalled();
    expect(renameSync).toHaveBeenCalled();

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Coverage for sendMessage catch block ---

  it('sendMessage returns false when file write throws', async () => {
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

    const mkdirSync = vi.mocked(fs.default.mkdirSync);
    mkdirSync.mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Coverage for enqueueTask when task is already running (line 96-98) ---

  it('enqueueTask skips when same taskId is already running', async () => {
    let resolveTask: () => void;
    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start the task — it will be running (runningTaskId set)
    queue.enqueueTask('group1@g.us', 'task-dup-running', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Try to enqueue the same taskId while it is still running
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-dup-running', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    // Duplicate should never be called
    expect(dupFn).not.toHaveBeenCalled();
    expect(taskFn).toHaveBeenCalledTimes(1);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Coverage for drainGroup pending messages after task completes (line 306) ---

  it('drainGroup runs pending messages after a task completes', async () => {
    let resolveTask: () => void;
    const taskRan = vi.fn();
    const taskFn = async () => {
      taskRan();
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    };

    const processed: string[] = [];
    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      return true;
    });
    queue.setProcessMessagesFn(processMessages);

    // Start a task for group1 (takes the slot)
    queue.enqueueTask('group1@g.us', 'task-before-msg', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskRan).toHaveBeenCalledTimes(1);

    // While the task is running, enqueue a message for the SAME group
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Messages should not have been processed yet (task is active)
    expect(processed).toHaveLength(0);

    // Complete the task — drainGroup should see pendingMessages and call runForGroup
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group1@g.us');
  });

  // --- Coverage for drainWaiting with tasks for waiting group (line 330) ---

  it('drainWaiting picks up pending tasks from waiting groups', async () => {
    const completionCallbacks: Array<() => void> = [];
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });
    queue.setProcessMessagesFn(processMessages);

    // Fill both slots with messages
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(completionCallbacks).toHaveLength(2);

    // Enqueue a TASK for a new group — goes to waiting since concurrency is full
    const waitingTaskFn = vi.fn(async () => {});
    queue.enqueueTask('group3@g.us', 'task-drain-waiting', waitingTaskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(waitingTaskFn).not.toHaveBeenCalled();

    // Complete group1 — drainWaiting should pick up group3's task
    completionCallbacks[0]!();
    await vi.advanceTimersByTimeAsync(10);
    expect(waitingTaskFn).toHaveBeenCalledTimes(1);
  });

  // --- Coverage for drainWaiting with messages for waiting group (line 337) ---

  it('drainWaiting picks up pending messages from waiting groups', async () => {
    const completionCallbacks: Array<() => void> = [];
    const processed: string[] = [];
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
    expect(completionCallbacks).toHaveLength(2);

    // Enqueue messages for group3 — goes to waiting
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Complete group1 — drainWaiting should pick up group3's messages
    completionCallbacks[0]!();
    await vi.advanceTimersByTimeAsync(10);
    expect(processed).toContain('group3@g.us');
  });
});
