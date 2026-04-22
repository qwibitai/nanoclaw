import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { retryWithBackoff } from './matrix.js';

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the operation result on first-try success', async () => {
    const op = vi.fn().mockResolvedValue('ok');

    const result = await retryWithBackoff(op, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    });

    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure and resolves when the operation eventually succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockRejectedValueOnce(new Error('second fail'))
      .mockResolvedValueOnce('ok');

    const promise = retryWithBackoff(op, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    });

    // After the first rejection, the backoff waits baseDelayMs * 2^0 = 100ms
    await vi.advanceTimersByTimeAsync(100);
    // After the second rejection, waits baseDelayMs * 2^1 = 200ms
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after maxAttempts consecutive failures', async () => {
    const err = new Error('persistent');
    const op = vi.fn().mockRejectedValue(err);

    const promise = retryWithBackoff(op, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    });
    // Swallow the pending rejection so vitest doesn't flag it as unhandled.
    promise.catch(() => {});

    // attempts 1 and 2 fail, each waits backoff
    await vi.advanceTimersByTimeAsync(100); // after attempt 1
    await vi.advanceTimersByTimeAsync(200); // after attempt 2
    // attempt 3 fails and throws immediately without waiting

    await expect(promise).rejects.toThrow('persistent');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('applies exponential backoff doubling until maxDelayMs cap', async () => {
    const op = vi.fn().mockRejectedValue(new Error('fail'));
    const onRetry = vi.fn();

    const promise = retryWithBackoff(op, {
      maxAttempts: 6,
      baseDelayMs: 100,
      maxDelayMs: 500,
      onRetry,
    });
    promise.catch(() => {});

    // Expected delays between attempts: 100, 200, 400, 500 (capped), 500 (capped)
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).rejects.toThrow();

    expect(onRetry).toHaveBeenCalledTimes(5);
    expect(onRetry.mock.calls[0][1]).toBe(100); // attempt 1 → 100ms
    expect(onRetry.mock.calls[1][1]).toBe(200); // attempt 2 → 200ms
    expect(onRetry.mock.calls[2][1]).toBe(400); // attempt 3 → 400ms
    expect(onRetry.mock.calls[3][1]).toBe(500); // attempt 4 → 800ms capped to 500
    expect(onRetry.mock.calls[4][1]).toBe(500); // attempt 5 → 1600ms capped to 500
  });

  it('calls onRetry with the attempt number, delay, and error', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockResolvedValueOnce('ok');
    const onRetry = vi.fn();

    const promise = retryWithBackoff(op, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    const [attempt, delayMs, err] = onRetry.mock.calls[0];
    expect(attempt).toBe(1);
    expect(delayMs).toBe(100);
    expect((err as Error).message).toBe('fail1');
  });

  it('calls onGiveUp once when all attempts are exhausted', async () => {
    const op = vi.fn().mockRejectedValue(new Error('persistent'));
    const onGiveUp = vi.fn();

    const promise = retryWithBackoff(op, {
      maxAttempts: 2,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      onGiveUp,
    });
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).rejects.toThrow();

    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0][0]).toBe(2); // final attempt number
    expect((onGiveUp.mock.calls[0][1] as Error).message).toBe('persistent');
  });

  it('does not call onGiveUp when the operation eventually succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce('ok');
    const onGiveUp = vi.fn();

    const promise = retryWithBackoff(op, {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      onGiveUp,
    });

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('does not wait after the final failed attempt', async () => {
    const op = vi.fn().mockRejectedValue(new Error('fail'));
    const start = Date.now();

    const promise = retryWithBackoff(op, {
      maxAttempts: 2,
      baseDelayMs: 10_000,
      maxDelayMs: 10_000,
    });
    promise.catch(() => {});

    // Only ONE backoff happens between attempts 1 and 2. After attempt 2
    // fails, the loop throws immediately — no trailing wait.
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(promise).rejects.toThrow();
    expect(op).toHaveBeenCalledTimes(2);
    // Elapsed should be exactly 10s, not 20s (no trailing wait)
    expect(Date.now() - start).toBe(10_000);
  });
});
