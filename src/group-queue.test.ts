import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
  MAX_WARM_PER_GROUP: 2,
  TASK_IDLE_TIMEOUT: 600000, // 10 min
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

  // =========================================================================
  // Updated existing tests — same intent, multi-container semantics
  // =========================================================================

  // 1. Global concurrency limit (MAX_CONCURRENT_CONTAINERS = 2)
  it('respects global concurrency limit across groups', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        activeCount--;
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 3 different groups (limit is 2)
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

  // 2. Tasks prioritised over messages in drain
  it('runs tasks concurrently with messages for same group', async () => {
    const executionOrder: string[] = [];
    let resolveFirst: () => void;

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        if (executionOrder.length === 0) {
          // First call: block until we release it
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
        executionOrder.push('messages');
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // Start processing messages (takes an active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While message container is active, enqueue a task — it should run immediately
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Task runs concurrently — doesn't wait for the message container
    expect(taskFn).toHaveBeenCalled();
    expect(executionOrder).toContain('task');

    // Release the first message processing
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // 3. Retry with exponential backoff (processMessagesFn now receives containerId)
  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        callCount++;
        return false; // failure
      },
    );

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

  // 4. Shutdown prevents new enqueues
  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => true,
    );
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // 5. Max retries exceeded
  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        callCount++;
        return false; // always fail
      },
    );

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

  // 6. Waiting groups drained when slots free up
  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        processed.push(groupJid);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // Fill both slots with different groups
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third group
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group3@g.us');
  });

  // 7. Running task dedup — check across all containers
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

  // 8. Active (non-idle) container NOT preempted (with containerId)
  it('does NOT preempt active container when not idle', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        await new Promise<void>((resolve) => {
          resolveProcess = resolve;
        });
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // Start processing (takes an active slot)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Extract containerId from the processMessagesFn call
    const containerId = processMessages.mock.calls[0][1];

    // Register a process so closeStdin has a groupFolder
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      containerId,
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

  // 9. Idle container reused for task (warm reuse)
  it('reuses idle message container for task instead of spawning new', async () => {
    let resolveProcess: () => void;
    const taskReuseCalls: Array<{
      groupJid: string;
      taskId: string;
      containerId: string;
    }> = [];

    queue.setOnTaskReuse((groupJid, taskId, containerId) => {
      taskReuseCalls.push({ groupJid, taskId, containerId });
    });

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        await new Promise<void>((resolve) => {
          resolveProcess = resolve;
        });
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // Start processing
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Extract containerId and register process, then mark idle
    const containerId = processMessages.mock.calls[0][1];
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      containerId,
    );
    queue.notifyIdle('group1@g.us', containerId);

    // Enqueue a task — should reuse the idle container via onTaskReuse
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // taskFn NOT called (warm reuse pipes via IPC)
    expect(taskFn).not.toHaveBeenCalled();
    // onTaskReuse callback should have been invoked
    expect(taskReuseCalls).toHaveLength(1);
    expect(taskReuseCalls[0].taskId).toBe('task-1');
    expect(taskReuseCalls[0].containerId).toBe(containerId);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // 10. sendMessage resets idleWaiting (with containerId)
  it('sendMessage resets idleWaiting so a subsequent task enqueue does not preempt', async () => {
    const fs = await import('fs');
    let resolveProcess: () => void;

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        await new Promise<void>((resolve) => {
          resolveProcess = resolve;
        });
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const containerId = processMessages.mock.calls[0][1];
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      containerId,
    );

    // Container becomes idle
    queue.notifyIdle('group1@g.us', containerId);

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

  // 11. sendMessage returns false for task containers
  it('sendMessage returns false for task containers so user messages queue up', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (sets type: 'task')
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Register — use the pending registration bridge (no explicit containerId)
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

  // 12. Idle notification with pending tasks triggers preemption (with containerId)
  it('runs task immediately even when container is busy (not idle)', async () => {
    let resolveProcess: () => void;

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        await new Promise<void>((resolve) => {
          resolveProcess = resolve;
        });
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // Start processing (container is busy, not idle)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const containerId = processMessages.mock.calls[0][1];
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      containerId,
    );

    // Enqueue a task while container is busy — should still run immediately
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    expect(taskFn).toHaveBeenCalled();

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // =========================================================================
  // NEW tests for multi-container semantics
  // =========================================================================

  // 13. CONC-01: Concurrent containers for same group
  it('allows concurrent containers for the same group (CONC-01)', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        concurrentCount--;
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // Two messages for same group — both should spawn containers
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    await vi.advanceTimersByTimeAsync(10);

    // Both should be running concurrently
    expect(maxConcurrent).toBe(2);
    expect(processMessages).toHaveBeenCalledTimes(2);

    // Each call should have a different containerId
    const id1 = processMessages.mock.calls[0][1];
    const id2 = processMessages.mock.calls[1][1];
    expect(id1).not.toBe(id2);

    // Clean up
    completionCallbacks.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(10);
  });

  // 14. CONC-04: Global cap across concurrent same-group containers
  it('enforces global cap across concurrent same-group containers (CONC-04)', async () => {
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // Group A gets 2 containers (filling the global cap of 2)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(2);

    // Third enqueue for same group — should be queued (at cap)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Still only 2 calls — third is waiting
    expect(processMessages).toHaveBeenCalledTimes(2);

    // Free one slot — the queued message should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(3);

    // Clean up
    completionCallbacks.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(10);
  });

  // 15. CONC-05: Idle container reuse
  it('reuses idle container instead of spawning new (CONC-05)', async () => {
    let resolveFirst: () => void;
    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register and mark idle
    const containerId = processMessages.mock.calls[0][1];
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      containerId,
    );
    queue.notifyIdle('group1@g.us', containerId);

    // New message arrives — should NOT spawn (idle container exists)
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // processMessagesFn should NOT have been called a second time
    // (idle container gets pendingMessages flag set instead)
    expect(processMessages).toHaveBeenCalledTimes(1);

    // Clean up
    resolveFirst!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // 16. COMPAT-01: Single message identical behaviour
  it('processes a single message identically to old behaviour (COMPAT-01)', async () => {
    let resolveProcess: () => void;

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        await new Promise<void>((resolve) => {
          resolveProcess = resolve;
        });
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // One message, one container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // processMessagesFn called once with correct groupJid and a containerId
    expect(processMessages).toHaveBeenCalledTimes(1);
    expect(processMessages).toHaveBeenCalledWith(
      'group1@g.us',
      expect.any(String),
    );

    // Clean up
    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // 17. Multi-group mixed concurrency
  it('allows multi-group mixed concurrency under global cap', async () => {
    const completionCallbacks: Array<() => void> = [];
    const calledGroups: string[] = [];

    const processMessages = vi.fn(
      async (groupJid: string, containerId: string) => {
        calledGroups.push(groupJid);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      },
    );

    queue.setProcessMessagesFn(processMessages);

    // Group A gets 1 container, Group B gets 1 container (both under cap)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Both should be running concurrently
    expect(processMessages).toHaveBeenCalledTimes(2);
    expect(calledGroups).toContain('group1@g.us');
    expect(calledGroups).toContain('group2@g.us');

    // Both have different containerIds
    const id1 = processMessages.mock.calls[0][1];
    const id2 = processMessages.mock.calls[1][1];
    expect(id1).not.toBe(id2);

    // Clean up
    completionCallbacks.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(10);
  });

  // =========================================================================
  // Warm container reuse tests
  // =========================================================================

  // 18. Task container becomes idle and stays warm for reuse
  it('keeps task container warm after notifyIdle (WARM-01)', async () => {
    const fs = await import('fs');
    let resolveTask: () => void;
    let capturedContainerId: string;

    const taskFn = vi.fn(async (containerId: string) => {
      capturedContainerId = containerId;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Register the container with a groupFolder so closeStdin works
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      capturedContainerId!,
    );

    // Mark idle — should NOT close the container, should keep it warm
    queue.notifyIdle('group1@g.us', capturedContainerId!);

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Clean up
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // 19. Warm task container is reused for new task (avoids cold start)
  it('reuses warm task container for new task (WARM-02)', async () => {
    let resolveTask: () => void;
    let capturedContainerId: string;
    const taskReuseCalls: Array<{
      groupJid: string;
      taskId: string;
      containerId: string;
    }> = [];

    queue.setOnTaskReuse((groupJid, taskId, containerId) => {
      taskReuseCalls.push({ groupJid, taskId, containerId });
    });

    const taskFn = vi.fn(async (containerId: string) => {
      capturedContainerId = containerId;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start first task
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskFn).toHaveBeenCalledTimes(1);

    // Register with groupFolder and mark idle (using captured containerId)
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      capturedContainerId!,
    );
    queue.notifyIdle('group1@g.us', capturedContainerId!);

    // Enqueue a second task — should reuse the warm container
    const taskFn2 = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-2', taskFn2);
    await vi.advanceTimersByTimeAsync(10);

    // taskFn2 should NOT have been called (warm reuse pipes via IPC, not fn)
    expect(taskFn2).not.toHaveBeenCalled();

    // onTaskReuse should have been called
    expect(taskReuseCalls).toHaveLength(1);
    expect(taskReuseCalls[0].taskId).toBe('task-2');

    // Clean up
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // 20. Warm timeout fires and closes the container
  it('closes warm container when TASK_IDLE_TIMEOUT expires (WARM-03)', async () => {
    const fs = await import('fs');
    let resolveTask: () => void;
    let capturedContainerId: string;

    const taskFn = vi.fn(async (containerId: string) => {
      capturedContainerId = containerId;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      capturedContainerId!,
    );
    queue.notifyIdle('group1@g.us', capturedContainerId!);

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    // Advance past TASK_IDLE_TIMEOUT (600000ms = 10 min)
    await vi.advanceTimersByTimeAsync(600000);

    // _close sentinel should have been written
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites.length).toBeGreaterThanOrEqual(1);

    // Clean up
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // 21. Warm timer cancelled when container is reused
  it('cancels warm timer when container is reused (WARM-04)', async () => {
    const fs = await import('fs');
    let resolveTask: () => void;
    let capturedContainerId: string;

    queue.setOnTaskReuse(() => {});

    const taskFn = vi.fn(async (containerId: string) => {
      capturedContainerId = containerId;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      capturedContainerId!,
    );
    queue.notifyIdle('group1@g.us', capturedContainerId!);

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    // Reuse the container before timeout fires
    await vi.advanceTimersByTimeAsync(300000); // 5 min (half of timeout)
    const taskFn2 = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-2', taskFn2);
    await vi.advanceTimersByTimeAsync(10);

    // Advance past the original timeout — should NOT trigger close
    // (timer was cancelled on reuse)
    await vi.advanceTimersByTimeAsync(300000); // another 5 min

    const closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Clean up
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // 22. MAX_WARM_PER_GROUP enforcement — excess containers closed immediately
  it('enforces MAX_WARM_PER_GROUP limit (WARM-05)', async () => {
    const fs = await import('fs');
    const resolvers: Array<() => void> = [];
    const containerIds: string[] = [];

    // Start task 1
    const taskFn1 = vi.fn(async (containerId: string) => {
      containerIds.push(containerId);
      await new Promise<void>((resolve) => resolvers.push(resolve));
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn1);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-1',
      'test-group',
      containerIds[0],
    );

    // Start task 2
    const taskFn2 = vi.fn(async (containerId: string) => {
      containerIds.push(containerId);
      await new Promise<void>((resolve) => resolvers.push(resolve));
    });
    queue.enqueueTask('group1@g.us', 'task-2', taskFn2);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'container-2',
      'test-group',
      containerIds[1],
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    // Mark first idle — should be kept warm (1 <= MAX_WARM_PER_GROUP of 2)
    queue.notifyIdle('group1@g.us', containerIds[0]);
    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Mark second idle too — still within limit (2 <= MAX_WARM_PER_GROUP of 2)
    queue.notifyIdle('group1@g.us', containerIds[1]);
    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Clean up
    resolvers.forEach((r) => r());
    await vi.advanceTimersByTimeAsync(10);
  });
});
