import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { eventBus } from './event-bus.js';
import type { NanoClawEvent } from './events.js';
import { ExecutorPool } from './executor-pool.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
  WARM_POOL_SIZE: 2,
  WARM_POOL_IDLE_TIMEOUT: 600000,
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

describe('ExecutorPool', () => {
  let pool: ExecutorPool;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus.removeAllListeners();
    pool = new ExecutorPool();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ===================================================================
  // Ported GroupQueue tests (18 tests)
  // ===================================================================

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

    pool.setProcessMessagesFn(processMessages);

    // Enqueue two messages for the same group
    pool.enqueueMessageCheck('group1@g.us');
    pool.enqueueMessageCheck('group1@g.us');

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

    pool.setProcessMessagesFn(processMessages);

    // Enqueue 3 groups (limit is 2)
    pool.enqueueMessageCheck('group1@g.us');
    pool.enqueueMessageCheck('group2@g.us');
    pool.enqueueMessageCheck('group3@g.us');

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

    pool.setProcessMessagesFn(processMessages);

    // Start processing messages (takes the active slot)
    pool.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // While active, enqueue both a task and pending messages
    const taskFn = vi.fn(async () => {
      executionOrder.push('task');
    });
    pool.enqueueTask('group1@g.us', 'task-1', taskFn);
    pool.enqueueMessageCheck('group1@g.us');

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

    pool.setProcessMessagesFn(processMessages);
    pool.enqueueMessageCheck('group1@g.us');

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
    pool.setProcessMessagesFn(processMessages);

    await pool.shutdown(1000);

    pool.enqueueMessageCheck('group1@g.us');
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

    pool.setProcessMessagesFn(processMessages);
    pool.enqueueMessageCheck('group1@g.us');

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

    pool.setProcessMessagesFn(processMessages);

    // Fill both slots
    pool.enqueueMessageCheck('group1@g.us');
    pool.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a third
    pool.enqueueMessageCheck('group3@g.us');
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
    pool.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    pool.enqueueTask('group1@g.us', 'task-1', dupFn);
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

    pool.setProcessMessagesFn(processMessages);

    // Start processing (takes the active slot)
    pool.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register a process so closeStdin has a groupFolder
    pool.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');

    // Enqueue a task while container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    pool.enqueueTask('group1@g.us', 'task-1', taskFn);

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

    pool.setProcessMessagesFn(processMessages);

    // Start processing
    pool.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and mark idle
    pool.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');
    pool.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    pool.enqueueTask('group1@g.us', 'task-1', taskFn);

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

    pool.setProcessMessagesFn(processMessages);
    pool.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    pool.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');

    // Container becomes idle
    pool.notifyIdle('group1@g.us');

    // A new user message arrives — resets idleWaiting
    pool.sendMessage('group1@g.us', 'hello');

    // Task enqueued after message reset — should NOT preempt (agent is working)
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    pool.enqueueTask('group1@g.us', 'task-1', taskFn);

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
    pool.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    pool.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');

    // sendMessage should return false — user messages must not go to task containers
    const result = pool.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Event emission ---

  it('emits task.started and task.complete for runForGroup', async () => {
    const events: NanoClawEvent[] = [];
    const unsub = eventBus.onAny((e) => events.push(e));

    const processMessages = vi.fn(async () => true);
    pool.setProcessMessagesFn(processMessages);

    pool.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    unsub();

    const started = events.filter((e) => e.type === 'task.started');
    const complete = events.filter((e) => e.type === 'task.complete');

    expect(started).toHaveLength(1);
    expect(started[0].groupId).toBe('group1@g.us');
    expect((started[0].payload as any).groupJid).toBe('group1@g.us');

    expect(complete).toHaveLength(1);
    expect(complete[0].groupId).toBe('group1@g.us');
    expect((complete[0].payload as any).status).toBe('success');
    expect((complete[0].payload as any).durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits task.complete with error status when processMessages returns false', async () => {
    const events: NanoClawEvent[] = [];
    const unsub = eventBus.onAny((e) => events.push(e));

    const processMessages = vi.fn(async () => false);
    pool.setProcessMessagesFn(processMessages);

    pool.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    unsub();

    const complete = events.filter((e) => e.type === 'task.complete');
    expect(complete).toHaveLength(1);
    expect((complete[0].payload as any).status).toBe('error');
  });

  it('emits task.started and task.complete for runTask', async () => {
    const events: NanoClawEvent[] = [];
    const unsub = eventBus.onAny((e) => events.push(e));

    const taskFn = vi.fn(async () => {});
    pool.enqueueTask('group1@g.us', 'my-task', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    unsub();

    const started = events.filter((e) => e.type === 'task.started');
    const complete = events.filter((e) => e.type === 'task.complete');

    expect(started).toHaveLength(1);
    expect((started[0].payload as any).taskId).toBe('my-task');
    expect((started[0].payload as any).groupJid).toBe('group1@g.us');

    expect(complete).toHaveLength(1);
    expect((complete[0].payload as any).taskId).toBe('my-task');
    expect((complete[0].payload as any).status).toBe('success');
  });

  it('emits task.complete with error status when task throws', async () => {
    const events: NanoClawEvent[] = [];
    const unsub = eventBus.onAny((e) => events.push(e));

    const taskFn = vi.fn(async () => {
      throw new Error('task failed');
    });
    pool.enqueueTask('group1@g.us', 'fail-task', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    unsub();

    const complete = events.filter((e) => e.type === 'task.complete');
    expect(complete).toHaveLength(1);
    expect((complete[0].payload as any).taskId).toBe('fail-task');
    expect((complete[0].payload as any).status).toBe('error');
  });

  it('emits task.queued when message is queued at capacity', async () => {
    const events: NanoClawEvent[] = [];
    const unsub = eventBus.onAny((e) => events.push(e));

    const completionCallbacks: Array<() => void> = [];
    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    pool.setProcessMessagesFn(processMessages);

    // Fill both slots (MAX_CONCURRENT_CONTAINERS = 2)
    pool.enqueueMessageCheck('group1@g.us');
    pool.enqueueMessageCheck('group2@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Third group should trigger task.queued
    pool.enqueueMessageCheck('group3@g.us');

    unsub();

    const queued = events.filter((e) => e.type === 'task.queued');
    expect(queued).toHaveLength(1);
    expect((queued[0].payload as any).groupJid).toBe('group3@g.us');
    expect((queued[0].payload as any).priority).toBe('interactive');
    expect((queued[0].payload as any).queuePosition).toBeGreaterThan(0);

    // Cleanup
    completionCallbacks.forEach((cb) => cb());
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

    pool.setProcessMessagesFn(processMessages);

    // Start processing
    pool.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Register process and enqueue a task (no idle yet — no preemption)
    pool.registerProcess('group1@g.us', {} as any, 'container-1', 'test-group');

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    pool.enqueueTask('group1@g.us', 'task-1', taskFn);

    let closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(0);

    // Now container becomes idle — should preempt because task is pending
    writeFileSync.mockClear();
    pool.notifyIdle('group1@g.us');

    closeWrites = writeFileSync.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].endsWith('_close'),
    );
    expect(closeWrites).toHaveLength(1);

    resolveProcess!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // ===================================================================
  // New ExecutorPool tests: Priority scheduling
  // ===================================================================

  describe('priority scheduling', () => {
    it('dequeues interactive tasks before scheduled tasks', async () => {
      const executionOrder: string[] = [];
      const completionCallbacks: Array<() => void> = [];

      const processMessages = vi.fn(async (groupJid: string) => {
        executionOrder.push(`msg:${groupJid}`);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });

      pool.setProcessMessagesFn(processMessages);

      // Fill both slots
      pool.enqueueMessageCheck('blocker1@g.us');
      pool.enqueueMessageCheck('blocker2@g.us');
      await vi.advanceTimersByTimeAsync(10);

      // Queue a scheduled task first, then an interactive message
      pool.enqueueTask(
        'scheduled-group@g.us',
        'sched-1',
        vi.fn(async () => {
          executionOrder.push('task:scheduled');
        }),
        'scheduled',
      );
      pool.enqueueMessageCheck('interactive-group@g.us'); // interactive priority

      // Free a slot — interactive should be dequeued first
      completionCallbacks[0]();
      await vi.advanceTimersByTimeAsync(10);

      // The interactive message should have been processed (not the scheduled task)
      expect(executionOrder).toContain('msg:interactive-group@g.us');

      // Free another slot for the scheduled task
      completionCallbacks[1]();
      await vi.advanceTimersByTimeAsync(10);

      // Now the scheduled task should have run
      expect(executionOrder).toContain('task:scheduled');
    });

    it('enqueueTask accepts optional priority parameter', async () => {
      const taskFn = vi.fn(async () => {});

      // Should not throw with explicit priority
      pool.enqueueTask('group1@g.us', 'task-1', taskFn, 'proactive');
      await vi.advanceTimersByTimeAsync(10);

      expect(taskFn).toHaveBeenCalled();
    });

    it('enqueueTask defaults to scheduled priority', async () => {
      const completionCallbacks: Array<() => void> = [];
      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });
      pool.setProcessMessagesFn(processMessages);

      // Fill slots
      pool.enqueueMessageCheck('blocker1@g.us');
      pool.enqueueMessageCheck('blocker2@g.us');
      await vi.advanceTimersByTimeAsync(10);

      // Enqueue task without explicit priority — should default to 'scheduled'
      // and be dequeued after any 'interactive' items
      const taskFn = vi.fn(async () => {});
      pool.enqueueTask('task-group@g.us', 'task-1', taskFn);

      // Add interactive message after the task
      pool.enqueueMessageCheck('interactive-group@g.us');

      // Free a slot — interactive should go first
      completionCallbacks[0]();
      await vi.advanceTimersByTimeAsync(10);

      expect(processMessages).toHaveBeenCalledWith('interactive-group@g.us');

      // Cleanup
      completionCallbacks.forEach((cb) => cb());
      await vi.advanceTimersByTimeAsync(10);
    });
  });

  // ===================================================================
  // New ExecutorPool tests: Warm pool
  // ===================================================================

  describe('warm pool', () => {
    it('emits pool.warm.created events on initWarmPool', async () => {
      const events: NanoClawEvent[] = [];
      const unsub = eventBus.onAny((e) => events.push(e));

      pool.initWarmPool();

      unsub();

      const created = events.filter((e) => e.type === 'pool.warm.created');
      // WARM_POOL_SIZE = 2, MAX_CONCURRENT_CONTAINERS = 2
      expect(created).toHaveLength(2);
      expect((created[0].payload as any).poolSize).toBe(1);
      expect((created[1].payload as any).poolSize).toBe(2);
    });

    it('emits pool.warm.used when a task claims a warm slot', async () => {
      const events: NanoClawEvent[] = [];
      pool.initWarmPool();

      const unsub = eventBus.onAny((e) => events.push(e));

      const taskFn = vi.fn(async () => {});
      pool.enqueueTask('group1@g.us', 'task-1', taskFn);
      await vi.advanceTimersByTimeAsync(10);

      unsub();

      const used = events.filter((e) => e.type === 'pool.warm.used');
      expect(used).toHaveLength(1);
      expect((used[0].payload as any).groupJid).toBe('group1@g.us');
      expect((used[0].payload as any).taskId).toBe('task-1');
    });

    it('emits pool.warm.evicted on idle timeout', async () => {
      const events: NanoClawEvent[] = [];
      pool.initWarmPool();

      const unsub = eventBus.onAny((e) => events.push(e));

      // Advance past WARM_POOL_IDLE_TIMEOUT (600000ms)
      await vi.advanceTimersByTimeAsync(600000);

      unsub();

      const evicted = events.filter((e) => e.type === 'pool.warm.evicted');
      expect(evicted).toHaveLength(2); // Both warm slots evicted
      expect((evicted[0].payload as any).reason).toBe('idle_timeout');
    });

    it('evicts all warm slots on shutdown', async () => {
      const events: NanoClawEvent[] = [];
      pool.initWarmPool();

      const unsub = eventBus.onAny((e) => events.push(e));

      await pool.shutdown(1000);

      unsub();

      const evicted = events.filter((e) => e.type === 'pool.warm.evicted');
      expect(evicted).toHaveLength(2);
      expect((evicted[0].payload as any).reason).toBe('shutdown');
      expect((evicted[1].payload as any).reason).toBe('shutdown');
    });

    it('does not create warm slots beyond available concurrency', async () => {
      const events: NanoClawEvent[] = [];

      // Fill both slots with real work
      const completionCallbacks: Array<() => void> = [];
      const processMessages = vi.fn(async () => {
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        return true;
      });
      pool.setProcessMessagesFn(processMessages);

      pool.enqueueMessageCheck('group1@g.us');
      pool.enqueueMessageCheck('group2@g.us');
      await vi.advanceTimersByTimeAsync(10);

      const unsub = eventBus.onAny((e) => events.push(e));

      // Try to init warm pool — no slots available
      pool.initWarmPool();

      unsub();

      const created = events.filter((e) => e.type === 'pool.warm.created');
      expect(created).toHaveLength(0);

      // Cleanup
      completionCallbacks.forEach((cb) => cb());
      await vi.advanceTimersByTimeAsync(10);
    });
  });

  describe('warm pool crash recovery', () => {
    it('recreates warm slot when crash is simulated', () => {
      pool.initWarmPool();
      expect(pool.getWarmSlotCount()).toBe(2);

      pool.simulateWarmSlotCrash(0);

      // replenishWarmPool is called synchronously within evictWarmSlot
      expect(pool.getWarmSlotCount()).toBe(2);
    });

    it('emits pool.warm.evicted event with crash reason', () => {
      const events: any[] = [];
      eventBus.on('pool.warm.evicted', (e: any) => events.push(e));

      pool.initWarmPool();
      pool.simulateWarmSlotCrash(0);

      expect(events).toHaveLength(1);
      expect(events[0].payload.reason).toBe('crash');
    });

    it('does nothing for invalid index', () => {
      pool.initWarmPool();
      pool.simulateWarmSlotCrash(99);
      expect(pool.getWarmSlotCount()).toBe(2);
    });
  });
});
