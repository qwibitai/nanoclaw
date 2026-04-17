import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  HOST_MODE: false,
  MAX_CONCURRENT_CONTAINERS: 2,
}));

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

import { GroupQueue } from './group-queue.js';

let queue: GroupQueue;

beforeEach(() => {
  vi.useFakeTimers();
  queue = new GroupQueue();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GroupQueue — retry with exponential backoff', () => {
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

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

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
});

describe('GroupQueue — onMaxRetriesExceeded callback', () => {
  it('calls onMaxRetriesExceeded when all retries are exhausted', async () => {
    let callCount = 0;
    const processMessages = vi.fn(async () => {
      callCount++;
      return false;
    });
    queue.setProcessMessagesFn(processMessages);

    const exceeded = vi.fn();
    queue.onMaxRetriesExceeded = exceeded;

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (const delay of retryDelays) {
      await vi.advanceTimersByTimeAsync(delay + 10);
    }

    expect(callCount).toBe(6);
    expect(exceeded).toHaveBeenCalledOnce();
    expect(exceeded).toHaveBeenCalledWith('group1@g.us');
  });

  it('does not call onMaxRetriesExceeded on successful retry', async () => {
    let callCount = 0;
    const processMessages = vi.fn(async () => {
      callCount++;
      return callCount >= 2;
    });
    queue.setProcessMessagesFn(processMessages);

    const exceeded = vi.fn();
    queue.onMaxRetriesExceeded = exceeded;

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(5010);

    expect(callCount).toBe(2);
    expect(exceeded).not.toHaveBeenCalled();
  });
});
