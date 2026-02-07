import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  MAX_CONCURRENT_CONTAINERS: 2,
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import { GroupQueue } from '../src/group-queue.js';

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('enqueueMessageCheck', () => {
    it('queues messages for processing and calls processMessagesFn', async () => {
      const processFn = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(processFn);

      queue.enqueueMessageCheck('group-a');

      // Allow the async runForGroup to complete
      await vi.advanceTimersByTimeAsync(0);

      expect(processFn).toHaveBeenCalledTimes(1);
      expect(processFn).toHaveBeenCalledWith('group-a');
    });

    it('queues a second message when group is already active', async () => {
      let resolveFirst!: () => void;
      const firstCall = new Promise<boolean>((resolve) => {
        resolveFirst = () => resolve(true);
      });

      const processFn = vi.fn()
        .mockReturnValueOnce(firstCall)
        .mockResolvedValue(true);

      queue.setProcessMessagesFn(processFn);

      queue.enqueueMessageCheck('group-a');
      await vi.advanceTimersByTimeAsync(0);

      // group-a is now active; enqueue another message
      queue.enqueueMessageCheck('group-a');

      // Complete the first call
      resolveFirst();
      await vi.advanceTimersByTimeAsync(0);

      // The pending message should trigger a second call (drain)
      await vi.advanceTimersByTimeAsync(0);

      expect(processFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('enqueueTask', () => {
    it('queues and runs a task immediately when slots are available', async () => {
      const taskFn = vi.fn().mockResolvedValue(undefined);
      queue.enqueueTask('group-a', 'task-1', taskFn);

      await vi.advanceTimersByTimeAsync(0);

      expect(taskFn).toHaveBeenCalledTimes(1);
    });

    it('does not double-queue the same task id', async () => {
      let resolveFirst!: () => void;
      const firstCall = new Promise<void>((resolve) => {
        resolveFirst = () => resolve();
      });
      const processFn = vi.fn().mockReturnValueOnce(firstCall).mockResolvedValue(true);
      queue.setProcessMessagesFn(processFn);

      // Make the group active via a message
      queue.enqueueMessageCheck('group-a');
      await vi.advanceTimersByTimeAsync(0);

      const taskFn = vi.fn().mockResolvedValue(undefined);
      queue.enqueueTask('group-a', 'task-dup', taskFn);
      queue.enqueueTask('group-a', 'task-dup', taskFn);

      resolveFirst();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      // The task should only be queued and run once
      expect(taskFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('setProcessMessagesFn + processing', () => {
    it('calls the registered function when a group is processed', async () => {
      const processFn = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(processFn);

      queue.enqueueMessageCheck('group-x');
      await vi.advanceTimersByTimeAsync(0);

      expect(processFn).toHaveBeenCalledWith('group-x');
    });

    it('does nothing when no processMessagesFn is set', async () => {
      // Should not throw even without a processFn
      queue.enqueueMessageCheck('group-y');
      await vi.advanceTimersByTimeAsync(0);
      // No assertion needed beyond not throwing
    });
  });

  describe('concurrency', () => {
    it('respects MAX_CONCURRENT_CONTAINERS limit of 2', async () => {
      let resolveA!: () => void;
      let resolveB!: () => void;
      const callA = new Promise<boolean>((r) => { resolveA = () => r(true); });
      const callB = new Promise<boolean>((r) => { resolveB = () => r(true); });

      const processFn = vi.fn()
        .mockReturnValueOnce(callA)
        .mockReturnValueOnce(callB)
        .mockResolvedValue(true);

      queue.setProcessMessagesFn(processFn);

      // Start two groups - both should run immediately
      queue.enqueueMessageCheck('group-1');
      queue.enqueueMessageCheck('group-2');
      await vi.advanceTimersByTimeAsync(0);

      expect(processFn).toHaveBeenCalledTimes(2);

      // Third group should be queued (at limit)
      queue.enqueueMessageCheck('group-3');
      await vi.advanceTimersByTimeAsync(0);

      // group-3 has NOT been called yet
      expect(processFn).toHaveBeenCalledTimes(2);

      // Complete group-1 to free a slot
      resolveA();
      await vi.advanceTimersByTimeAsync(0);

      // group-3 should now be running
      expect(processFn).toHaveBeenCalledTimes(3);
      expect(processFn).toHaveBeenLastCalledWith('group-3');

      // Cleanup
      resolveB();
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  describe('retry with backoff on failure', () => {
    it('schedules a retry when processMessagesFn returns false', async () => {
      const processFn = vi.fn()
        .mockResolvedValueOnce(false)   // First call fails
        .mockResolvedValue(true);       // Retry succeeds

      queue.setProcessMessagesFn(processFn);

      queue.enqueueMessageCheck('group-retry');
      await vi.advanceTimersByTimeAsync(0);

      expect(processFn).toHaveBeenCalledTimes(1);

      // Retry is scheduled with BASE_RETRY_MS (5000) * 2^0 = 5000ms
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);

      expect(processFn).toHaveBeenCalledTimes(2);
      expect(processFn).toHaveBeenLastCalledWith('group-retry');
    });

    it('schedules a retry when processMessagesFn throws', async () => {
      const processFn = vi.fn()
        .mockRejectedValueOnce(new Error('container crash'))
        .mockResolvedValue(true);

      queue.setProcessMessagesFn(processFn);

      queue.enqueueMessageCheck('group-err');
      await vi.advanceTimersByTimeAsync(0);

      expect(processFn).toHaveBeenCalledTimes(1);

      // Retry after 5000ms backoff
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);

      expect(processFn).toHaveBeenCalledTimes(2);
    });

    it('uses exponential backoff for consecutive failures', async () => {
      const processFn = vi.fn()
        .mockResolvedValueOnce(false)   // fail 1
        .mockResolvedValueOnce(false)   // fail 2
        .mockResolvedValue(true);       // succeed

      queue.setProcessMessagesFn(processFn);

      queue.enqueueMessageCheck('group-exp');
      await vi.advanceTimersByTimeAsync(0);
      expect(processFn).toHaveBeenCalledTimes(1);

      // First retry: 5000 * 2^0 = 5000ms
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);
      expect(processFn).toHaveBeenCalledTimes(2);

      // Second retry: 5000 * 2^1 = 10000ms
      await vi.advanceTimersByTimeAsync(10000);
      await vi.advanceTimersByTimeAsync(0);
      expect(processFn).toHaveBeenCalledTimes(3);
    });

    it('resets retry count after a success', async () => {
      const processFn = vi.fn()
        .mockResolvedValueOnce(false)   // fail
        .mockResolvedValue(true);       // succeed

      queue.setProcessMessagesFn(processFn);

      queue.enqueueMessageCheck('group-reset');
      await vi.advanceTimersByTimeAsync(0);

      // Wait for retry
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);

      expect(processFn).toHaveBeenCalledTimes(2);

      // Now enqueue again - if retry count was reset, this should work normally
      queue.enqueueMessageCheck('group-reset');
      await vi.advanceTimersByTimeAsync(0);

      expect(processFn).toHaveBeenCalledTimes(3);
    });
  });

  describe('shutdown', () => {
    it('prevents new messages from being enqueued', async () => {
      const processFn = vi.fn().mockResolvedValue(true);
      queue.setProcessMessagesFn(processFn);

      await queue.shutdown(1000);

      queue.enqueueMessageCheck('group-after-shutdown');
      await vi.advanceTimersByTimeAsync(0);

      expect(processFn).not.toHaveBeenCalled();
    });

    it('prevents new tasks from being enqueued', async () => {
      const taskFn = vi.fn().mockResolvedValue(undefined);

      await queue.shutdown(1000);

      queue.enqueueTask('group-after-shutdown', 'task-1', taskFn);
      await vi.advanceTimersByTimeAsync(0);

      expect(taskFn).not.toHaveBeenCalled();
    });

    it('resolves immediately when there are no active processes', async () => {
      // No active containers - shutdown should resolve quickly
      await expect(queue.shutdown(1000)).resolves.toBeUndefined();
    });
  });
});
