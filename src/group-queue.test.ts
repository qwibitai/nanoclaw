import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  DEFAULT_SESSION_NAME,
  GroupQueue,
  MAINTENANCE_SESSION_NAME,
} from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
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
    queue.enqueueTask('group1@g.us', 'task-1', DEFAULT_SESSION_NAME, taskFn);
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
    queue.enqueueTask('group1@g.us', 'task-1', DEFAULT_SESSION_NAME, taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    // Scheduler poll re-discovers the same task while it's running —
    // this must be silently dropped
    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', DEFAULT_SESSION_NAME, dupFn);
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
      DEFAULT_SESSION_NAME,
      {} as unknown as import('child_process').ChildProcess,
      'container-1',
      'test-group',
    );

    // Enqueue a task while container is active but NOT idle
    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', DEFAULT_SESSION_NAME, taskFn);

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
      DEFAULT_SESSION_NAME,
      {} as unknown as import('child_process').ChildProcess,
      'container-1',
      'test-group',
    );
    queue.notifyIdle('group1@g.us');

    // Clear previous writes, then enqueue a task
    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', DEFAULT_SESSION_NAME, taskFn);

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
      DEFAULT_SESSION_NAME,
      {} as unknown as import('child_process').ChildProcess,
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
    queue.enqueueTask('group1@g.us', 'task-1', DEFAULT_SESSION_NAME, taskFn);

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
    queue.enqueueTask('group1@g.us', 'task-1', DEFAULT_SESSION_NAME, taskFn);
    await vi.advanceTimersByTimeAsync(10);
    queue.registerProcess(
      'group1@g.us',
      DEFAULT_SESSION_NAME,
      {} as unknown as import('child_process').ChildProcess,
      'container-1',
      'test-group',
    );

    // sendMessage should return false — user messages must not go to task containers
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Parallel sessions per group (maintenance vs default) ---

  it('two tasks on the same group with different sessionName run concurrently', async () => {
    // Proves the core reason the maintenance session exists: a long-running
    // scheduled task in one session MUST NOT block a user-facing task in
    // the other session for the same group. Without the session-keyed
    // queue slots both tasks would serialize.
    let concurrent = 0;
    let peak = 0;
    const release: Array<() => void> = [];

    const makeTask = () =>
      vi.fn(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise<void>((r) => release.push(r));
        concurrent--;
      });

    queue.enqueueTask(
      'group1@g.us',
      'user-task',
      DEFAULT_SESSION_NAME,
      makeTask(),
    );
    queue.enqueueTask(
      'group1@g.us',
      'maint-task',
      MAINTENANCE_SESSION_NAME,
      makeTask(),
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(peak).toBe(2);
    expect(concurrent).toBe(2);

    // Release both
    release.forEach((r) => r());
    await vi.advanceTimersByTimeAsync(10);
  });

  it('closeStdin(default) and closeStdin(maintenance) write to separate input dirs', async () => {
    // Regression guard: both sessions mount their own per-session input dir
    // (`input-default/`, `input-maintenance/`). If this test fails, a _close
    // sentinel written for one session would be visible to — and consumed
    // by — the other session's container, silently killing parallel work.
    const fs = await import('fs');

    // Get both sessions into the "active with groupFolder" state that
    // closeStdin requires to actually write a sentinel.
    queue.registerProcess(
      'group1@g.us',
      DEFAULT_SESSION_NAME,
      {} as unknown as import('child_process').ChildProcess,
      'container-default',
      'test-group',
    );
    queue.registerProcess(
      'group1@g.us',
      MAINTENANCE_SESSION_NAME,
      {} as unknown as import('child_process').ChildProcess,
      'container-maintenance',
      'test-group',
    );

    // registerProcess alone doesn't flip `state.active = true`; enqueue a
    // real task per session so closeStdin has something to close.
    let releaseDefault: (() => void) | undefined;
    let releaseMaint: (() => void) | undefined;
    queue.enqueueTask(
      'group1@g.us',
      'default-task',
      DEFAULT_SESSION_NAME,
      async () => {
        await new Promise<void>((r) => {
          releaseDefault = r;
        });
      },
    );
    queue.enqueueTask(
      'group1@g.us',
      'maint-task',
      MAINTENANCE_SESSION_NAME,
      async () => {
        await new Promise<void>((r) => {
          releaseMaint = r;
        });
      },
    );
    await vi.advanceTimersByTimeAsync(10);

    // Re-register now that runTask flipped active=true (runTask cleared
    // process/groupFolder during its setup path in the test harness).
    queue.registerProcess(
      'group1@g.us',
      DEFAULT_SESSION_NAME,
      {} as unknown as import('child_process').ChildProcess,
      'container-default',
      'test-group',
    );
    queue.registerProcess(
      'group1@g.us',
      MAINTENANCE_SESSION_NAME,
      {} as unknown as import('child_process').ChildProcess,
      'container-maintenance',
      'test-group',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    queue.closeStdin('group1@g.us', DEFAULT_SESSION_NAME);
    queue.closeStdin('group1@g.us', MAINTENANCE_SESSION_NAME);

    const closeWrites = writeFileSync.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .filter((p) => p.endsWith('_close'));

    expect(closeWrites).toHaveLength(2);
    expect(closeWrites.some((p) => p.includes('input-default'))).toBe(true);
    expect(closeWrites.some((p) => p.includes('input-maintenance'))).toBe(true);
    // Neither sentinel lands in the legacy shared `input/` path.
    expect(closeWrites.some((p) => /[/\\]input[/\\]_close$/.test(p))).toBe(
      false,
    );

    releaseDefault?.();
    releaseMaint?.();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('drainWaiting under saturation prefers default slots over maintenance', async () => {
    // MAX_CONCURRENT_CONTAINERS is mocked to 2. Fill both slots with
    // blocking maintenance tasks, then queue BOTH a maintenance task AND a
    // user message (for different groups). When ONE slot frees, the queue
    // must drain the USER-FACING message ahead of the queued maintenance
    // task — that's the whole point of parallel maintenance: scheduled
    // work doesn't block user replies under contention.
    const release: Array<() => void> = [];
    const blockingTask = () =>
      vi.fn(async () => {
        await new Promise<void>((r) => release.push(r));
      });

    // Fill both concurrent slots.
    queue.enqueueTask(
      'a@g.us',
      'block-a',
      MAINTENANCE_SESSION_NAME,
      blockingTask(),
    );
    queue.enqueueTask(
      'b@g.us',
      'block-b',
      MAINTENANCE_SESSION_NAME,
      blockingTask(),
    );
    await vi.advanceTimersByTimeAsync(10);

    // Queue maintenance FIRST (older entry), then user message — priority
    // logic must override FIFO insertion order.
    let maintRan = false;
    let msgRan = false;
    queue.enqueueTask(
      'c@g.us',
      'queued-maint',
      MAINTENANCE_SESSION_NAME,
      vi.fn(async () => {
        maintRan = true;
      }),
    );
    // processMessages must block so the freed slot stays occupied while we
    // observe — otherwise the message finishes synchronously, frees the
    // slot, and drainWaiting would pick up the maintenance task too.
    let releaseMsg: (() => void) | undefined;
    queue.setProcessMessagesFn(async () => {
      msgRan = true;
      await new Promise<void>((r) => {
        releaseMsg = r;
      });
      return true;
    });
    queue.enqueueMessageCheck('d@g.us');

    // Release ONE blocking slot — only the user message should be drained.
    release[0]!();
    await vi.advanceTimersByTimeAsync(10);

    expect(msgRan).toBe(true);
    expect(maintRan).toBe(false);

    // Release the message, then the second blocking task → maintenance runs.
    releaseMsg!();
    release[1]!();
    await vi.advanceTimersByTimeAsync(10);
    expect(maintRan).toBe(true);
  });

  it('two tasks on the same group with the same sessionName serialize', async () => {
    // Within a session the slot is still single-serial — same as before,
    // just keyed by (groupJid, sessionName) instead of groupJid alone.
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = vi.fn(async () => {
      order.push('first:start');
      await new Promise<void>((r) => {
        releaseFirst = r;
      });
      order.push('first:end');
    });
    const second = vi.fn(async () => {
      order.push('second:start');
      order.push('second:end');
    });

    queue.enqueueTask('group1@g.us', 'task-A', MAINTENANCE_SESSION_NAME, first);
    queue.enqueueTask(
      'group1@g.us',
      'task-B',
      MAINTENANCE_SESSION_NAME,
      second,
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(order).toEqual(['first:start']);

    releaseFirst!();
    await vi.advanceTimersByTimeAsync(10);

    expect(order).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'second:end',
    ]);
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
      DEFAULT_SESSION_NAME,
      {} as unknown as import('child_process').ChildProcess,
      'container-1',
      'test-group',
    );

    const writeFileSync = vi.mocked(fs.default.writeFileSync);
    writeFileSync.mockClear();

    const taskFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', DEFAULT_SESSION_NAME, taskFn);

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
