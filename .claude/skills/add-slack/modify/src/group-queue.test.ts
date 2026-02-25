import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GroupQueue } from './group-queue.js';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Skill GroupQueue exhaustion drop', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onExhaustionDrop callback after MAX_RETRIES exceeded', async () => {
    const onExhaustionDrop = vi.fn();
    let callCount = 0;

    queue.setProcessMessagesFn(async () => {
      callCount++;
      return false;
    });
    queue.setOnExhaustionDropFn(onExhaustionDrop);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (const delay of retryDelays) {
      await vi.advanceTimersByTimeAsync(delay + 10);
    }

    expect(callCount).toBe(6);
    expect(onExhaustionDrop).toHaveBeenCalledTimes(1);
    expect(onExhaustionDrop).toHaveBeenCalledWith('group1@g.us');
  });

  it('clears pendingMessages on exhaustion drop', async () => {
    let callCount = 0;

    queue.setProcessMessagesFn(async (groupJid) => {
      callCount++;
      if (callCount === 6) {
        queue.enqueueMessageCheck(groupJid);
      }
      return false;
    });
    queue.setOnExhaustionDropFn(() => {});

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (const delay of retryDelays) {
      await vi.advanceTimersByTimeAsync(delay + 10);
    }

    const state = (queue as any).groups.get('group1@g.us');
    expect(state.pendingMessages).toBe(false);
  });

  it('new messages after exhaustion drop are processed normally', async () => {
    let callCount = 0;

    queue.setProcessMessagesFn(async () => {
      callCount++;
      if (callCount <= 6) {
        return false;
      }
      return true;
    });
    queue.setOnExhaustionDropFn(() => {});

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (const delay of retryDelays) {
      await vi.advanceTimersByTimeAsync(delay + 10);
    }
    expect(callCount).toBe(6);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const state = (queue as any).groups.get('group1@g.us');
    expect(callCount).toBe(7);
    expect(state.retryCount).toBe(0);
  });

  it('no stale replay loop after exhaustion', async () => {
    let callCount = 0;

    queue.setProcessMessagesFn(async () => {
      callCount++;
      return false;
    });
    queue.setOnExhaustionDropFn(() => {});

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (const delay of retryDelays) {
      await vi.advanceTimersByTimeAsync(delay + 10);
    }

    const callCountAfterExhaustion = callCount;
    await vi.advanceTimersByTimeAsync(200000);
    expect(callCount).toBe(callCountAfterExhaustion);
  });
});
