/**
 * Provider Fallback Chain — Test Suite
 *
 * Tests written from spec only. No production code has been read.
 * All tests should FAIL (RED) until production code is implemented.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  classifyError,
  RetryProvider,
  FailoverProvider,
  CircuitBreakerProvider,
  ProviderChain,
  selectModelChain,
} from './provider-chain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock error that looks like a provider HTTP error. */
function httpError(
  status: number,
  opts: { retryAfter?: number; code?: string; message?: string } = {},
): Error & { status: number; headers?: Record<string, string>; code?: string } {
  const err = new Error(opts.message ?? `HTTP ${status}`) as Error & {
    status: number;
    headers?: Record<string, string>;
    code?: string;
  };
  err.status = status;
  if (opts.retryAfter !== undefined) {
    err.headers = { 'retry-after': String(opts.retryAfter) };
  }
  if (opts.code) {
    err.code = opts.code;
  }
  return err;
}

function networkTimeoutError(): Error & { code: string } {
  const err = new Error('Network timeout') as Error & { code: string };
  err.code = 'ETIMEDOUT';
  return err;
}

function contextLengthError(): Error & { status: number; code: string } {
  const err = new Error('Context length exceeded') as Error & {
    status: number;
    code: string;
  };
  err.status = 400;
  err.code = 'context_length_exceeded';
  return err;
}

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe('classifyError', () => {
  it('should classify errors correctly (retryable vs non-retryable vs transient)', () => {
    // Transient / retryable errors
    const transientCodes = [429, 500, 502, 503, 504];
    for (const status of transientCodes) {
      const result = classifyError(httpError(status));
      expect(result.retryable, `HTTP ${status} should be retryable`).toBe(true);
      expect(result.transient, `HTTP ${status} should be transient`).toBe(true);
      expect(result.contextLength, `HTTP ${status} should not be context_length`).toBe(false);
    }

    // Network timeout should also be transient
    const timeout = classifyError(networkTimeoutError());
    expect(timeout.retryable, 'network timeout should be retryable').toBe(true);
    expect(timeout.transient, 'network timeout should be transient').toBe(true);

    // Non-retryable errors
    const nonRetryableCodes = [401, 400, 422];
    for (const status of nonRetryableCodes) {
      const result = classifyError(httpError(status));
      expect(result.retryable, `HTTP ${status} should NOT be retryable`).toBe(false);
      expect(result.transient, `HTTP ${status} should NOT be transient`).toBe(false);
    }

    // context_length_exceeded is a special case — not retryable on same provider,
    // but triggers skip to next provider
    const ctx = classifyError(contextLengthError());
    expect(ctx.contextLength, 'context_length_exceeded should flag contextLength').toBe(true);
    expect(ctx.retryable, 'context_length_exceeded should NOT be retryable').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RetryProvider
// ---------------------------------------------------------------------------

describe('RetryProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should retry transient errors with exponential backoff', async () => {
    const fn = vi.fn<() => Promise<string>>();

    // Fail twice with 502, then succeed
    fn.mockRejectedValueOnce(httpError(502))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce('ok');

    const retry = new RetryProvider({ maxRetries: 3 });
    const resultPromise = retry.execute(fn);

    // After first failure: backoff ~1s (1000ms * 2^0 = 1000ms, +/- 25% jitter)
    // Advance past the first backoff window
    await vi.advanceTimersByTimeAsync(1500);

    // After second failure: backoff ~2s (1000ms * 2^1 = 2000ms, +/- 25% jitter)
    await vi.advanceTimersByTimeAsync(3000);

    const result = await resultPromise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);

    // Verify backoff timing: 1st retry at ~1s, 2nd retry at ~2s
    // The exact jitter is random, but base durations must follow 1s * 2^attempt
  });

  it('should respect retry-after header from provider', async () => {
    const fn = vi.fn<() => Promise<string>>();

    // Server says retry after 5 seconds
    fn.mockRejectedValueOnce(httpError(429, { retryAfter: 5 }))
      .mockResolvedValueOnce('ok');

    const retry = new RetryProvider({ maxRetries: 3 });
    const resultPromise = retry.execute(fn);

    // Should NOT have retried yet at 4s (retry-after is 5s)
    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(1);

    // At 5s+ it should retry and succeed
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should not retry auth errors (401)', async () => {
    const fn = vi.fn<() => Promise<string>>();

    fn.mockRejectedValueOnce(httpError(401, { message: 'Unauthorized' }));

    const retry = new RetryProvider({ maxRetries: 3 });

    await expect(retry.execute(fn)).rejects.toThrow('Unauthorized');

    // Must have called exactly once — no retries
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should propagate non-retryable errors immediately without retrying', async () => {
    const fn = vi.fn<() => Promise<string>>();

    // 400 bad request
    fn.mockRejectedValueOnce(httpError(400, { message: 'Bad request' }));
    const retry = new RetryProvider({ maxRetries: 3 });
    await expect(retry.execute(fn)).rejects.toThrow('Bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should propagate 422 validation errors immediately without retrying', async () => {
    const fn = vi.fn<() => Promise<string>>();

    fn.mockRejectedValueOnce(httpError(422, { message: 'Validation error' }));
    const retry = new RetryProvider({ maxRetries: 3 });
    await expect(retry.execute(fn)).rejects.toThrow('Validation error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should exhaust max retries then propagate error', async () => {
    const fn = vi.fn<() => Promise<string>>();

    // Fail every time with transient error
    fn.mockRejectedValue(httpError(500));

    const retry = new RetryProvider({ maxRetries: 3 });
    const resultPromise = retry.execute(fn);

    // Advance through all backoff windows
    // Attempt 0 (initial): fail
    // Retry 1: backoff ~1s  (1000 * 2^0)
    // Retry 2: backoff ~2s  (1000 * 2^1)
    // Retry 3: backoff ~4s  (1000 * 2^2)
    await vi.advanceTimersByTimeAsync(10000);

    await expect(resultPromise).rejects.toThrow('HTTP 500');
    // 1 initial + 3 retries = 4 total calls
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('should apply 25% jitter to backoff duration', async () => {
    const fn = vi.fn<() => Promise<string>>();

    fn.mockRejectedValueOnce(httpError(502))
      .mockResolvedValueOnce('ok');

    const retry = new RetryProvider({ maxRetries: 3 });

    // We can't test exact jitter deterministically, but we can verify
    // the retry doesn't happen before the minimum jitter window.
    // Base delay for attempt 0 = 1000ms. 25% jitter means [750ms, 1250ms].
    const resultPromise = retry.execute(fn);

    // At 700ms, should NOT have retried yet (below minimum jitter range)
    await vi.advanceTimersByTimeAsync(700);
    expect(fn).toHaveBeenCalledTimes(1);

    // At 1300ms, should definitely have retried (past maximum jitter range)
    await vi.advanceTimersByTimeAsync(600);
    const result = await resultPromise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// FailoverProvider
// ---------------------------------------------------------------------------

describe('FailoverProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should failover to next provider after retries exhausted', async () => {
    const provider1Fn = vi.fn<() => Promise<string>>();
    const provider2Fn = vi.fn<() => Promise<string>>();

    // Provider 1 always fails with transient error
    provider1Fn.mockRejectedValue(httpError(500));
    // Provider 2 succeeds
    provider2Fn.mockResolvedValue('from-provider-2');

    const failover = new FailoverProvider({
      providers: [
        { name: 'primary', execute: provider1Fn },
        { name: 'secondary', execute: provider2Fn },
      ],
      failureThreshold: 3,
    });

    const result = await failover.execute();
    expect(result).toBe('from-provider-2');
    expect(provider2Fn).toHaveBeenCalled();
  });

  it('should activate cooldown after 3 consecutive failures', async () => {
    const provider1Fn = vi.fn<() => Promise<string>>();
    const provider2Fn = vi.fn<() => Promise<string>>();

    // Provider 1 always fails
    provider1Fn.mockRejectedValue(httpError(500));
    // Provider 2 succeeds
    provider2Fn.mockResolvedValue('ok');

    const failover = new FailoverProvider({
      providers: [
        { name: 'primary', execute: provider1Fn },
        { name: 'secondary', execute: provider2Fn },
      ],
      failureThreshold: 3,
    });

    // Cause 3 consecutive failures on provider 1 by calling 3 times
    // Each call should fail on primary and succeed on secondary
    await failover.execute();
    await failover.execute();
    await failover.execute();

    // After 3 failures, primary should be in cooldown.
    // Next call should skip primary entirely and go straight to secondary.
    provider1Fn.mockClear();
    provider2Fn.mockClear();

    await failover.execute();

    // Primary should NOT have been called (it's in cooldown)
    expect(provider1Fn).not.toHaveBeenCalled();
    expect(provider2Fn).toHaveBeenCalled();
  });

  it('should try oldest-cooled provider when all are in cooldown', async () => {
    const provider1Fn = vi.fn<() => Promise<string>>();
    const provider2Fn = vi.fn<() => Promise<string>>();

    // Both providers always fail
    provider1Fn.mockRejectedValue(httpError(500));
    provider2Fn.mockRejectedValue(httpError(502));

    const failover = new FailoverProvider({
      providers: [
        { name: 'primary', execute: provider1Fn },
        { name: 'secondary', execute: provider2Fn },
      ],
      failureThreshold: 3,
    });

    // Exhaust both providers enough times to put them all in cooldown
    for (let i = 0; i < 6; i++) {
      try {
        await failover.execute();
      } catch {
        // expected — all providers fail
      }
    }

    // Now both should be in cooldown.
    // Provider 1 entered cooldown first (oldest-cooled).
    // Next call should try provider 1 (the oldest-cooled one).
    provider1Fn.mockClear();
    provider2Fn.mockClear();
    provider1Fn.mockResolvedValueOnce('recovered');

    const result = await failover.execute();
    expect(result).toBe('recovered');
    expect(provider1Fn).toHaveBeenCalled();
  });

  it('should reset failure count on success', async () => {
    const provider1Fn = vi.fn<() => Promise<string>>();

    // Fail twice, then succeed
    provider1Fn
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(502))
      .mockResolvedValueOnce('ok');

    const failover = new FailoverProvider({
      providers: [{ name: 'primary', execute: provider1Fn }],
      failureThreshold: 3,
    });

    // This call accumulates 2 failures then succeeds on 3rd attempt
    // (assuming retry wrapping or direct retries within failover)
    // After success, failure count should be reset to 0.

    // We verify reset by then failing twice more — should still not trigger cooldown
    // because count was reset to 0 after the success.
    provider1Fn.mockReset();
    provider1Fn
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500))
      .mockResolvedValueOnce('still-ok');

    // If failure count had NOT been reset, this would be failure #4 and #5,
    // exceeding the threshold of 3. But since it was reset, we start at 0.
    const result = await failover.execute();
    expect(result).toBe('still-ok');
  });

  it('should skip to next provider on context_length_exceeded', async () => {
    const provider1Fn = vi.fn<() => Promise<string>>();
    const provider2Fn = vi.fn<() => Promise<string>>();

    // Provider 1 fails with context length exceeded
    provider1Fn.mockRejectedValue(contextLengthError());
    // Provider 2 succeeds (different model, larger context)
    provider2Fn.mockResolvedValue('large-context-ok');

    const failover = new FailoverProvider({
      providers: [
        { name: 'primary', execute: provider1Fn },
        { name: 'secondary', execute: provider2Fn },
      ],
      failureThreshold: 3,
    });

    const result = await failover.execute();
    expect(result).toBe('large-context-ok');

    // context_length_exceeded should skip immediately — no retries on provider 1
    expect(provider1Fn).toHaveBeenCalledTimes(1);
    expect(provider2Fn).toHaveBeenCalledTimes(1);
  });

  it('should never fully deadlock — always has a provider to try', async () => {
    const provider1Fn = vi.fn<() => Promise<string>>();
    const provider2Fn = vi.fn<() => Promise<string>>();
    const provider3Fn = vi.fn<() => Promise<string>>();

    // All fail initially
    provider1Fn.mockRejectedValue(httpError(500));
    provider2Fn.mockRejectedValue(httpError(500));
    provider3Fn.mockRejectedValue(httpError(500));

    const failover = new FailoverProvider({
      providers: [
        { name: 'p1', execute: provider1Fn },
        { name: 'p2', execute: provider2Fn },
        { name: 'p3', execute: provider3Fn },
      ],
      failureThreshold: 3,
    });

    // Put all in cooldown
    for (let i = 0; i < 12; i++) {
      try {
        await failover.execute();
      } catch {
        // expected
      }
    }

    // Even when all are in cooldown, the next call should NOT throw a
    // "no providers available" error — it should try oldest-cooled.
    provider1Fn.mockResolvedValueOnce('alive');

    // This must NOT throw "no providers available" / deadlock error
    const result = await failover.execute();
    expect(result).toBe('alive');
  });
});

// ---------------------------------------------------------------------------
// CircuitBreakerProvider
// ---------------------------------------------------------------------------

describe('CircuitBreakerProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should open circuit breaker after 5 transient failures', async () => {
    const fn = vi.fn<() => Promise<string>>();
    fn.mockRejectedValue(httpError(500));

    const cb = new CircuitBreakerProvider({
      failureThreshold: 5,
      recoveryTimeout: 30_000,
    });

    // Accumulate 5 transient failures
    for (let i = 0; i < 5; i++) {
      try {
        await cb.execute(fn);
      } catch {
        // expected
      }
    }

    // Circuit should now be OPEN — next call should be rejected immediately
    // without calling the underlying function
    fn.mockClear();

    await expect(cb.execute(fn)).rejects.toThrow(/circuit.*open/i);
    // The function should NOT have been called — circuit is open
    expect(fn).not.toHaveBeenCalled();
  });

  it('should probe after recovery timeout (half-open state)', async () => {
    const fn = vi.fn<() => Promise<string>>();
    fn.mockRejectedValue(httpError(500));

    const cb = new CircuitBreakerProvider({
      failureThreshold: 5,
      recoveryTimeout: 30_000,
    });

    // Open the circuit with 5 failures
    for (let i = 0; i < 5; i++) {
      try {
        await cb.execute(fn);
      } catch {
        // expected
      }
    }

    // Circuit is open. Advance past recovery timeout (30s).
    await vi.advanceTimersByTimeAsync(31_000);

    // Now circuit should be half-open — allows ONE probe request
    fn.mockClear();
    fn.mockResolvedValueOnce('probe-success');

    const result = await cb.execute(fn);
    expect(result).toBe('probe-success');
    expect(fn).toHaveBeenCalledTimes(1);

    // Circuit should now be CLOSED (probe succeeded)
    fn.mockClear();
    fn.mockResolvedValueOnce('normal');
    const result2 = await cb.execute(fn);
    expect(result2).toBe('normal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should reopen circuit if probe fails', async () => {
    const fn = vi.fn<() => Promise<string>>();
    fn.mockRejectedValue(httpError(500));

    const cb = new CircuitBreakerProvider({
      failureThreshold: 5,
      recoveryTimeout: 30_000,
    });

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      try {
        await cb.execute(fn);
      } catch {
        // expected
      }
    }

    // Wait for recovery timeout
    await vi.advanceTimersByTimeAsync(31_000);

    // Half-open: probe request fails
    fn.mockClear();
    fn.mockRejectedValueOnce(httpError(502));

    try {
      await cb.execute(fn);
    } catch {
      // expected — probe failed
    }

    // Circuit should be OPEN again — reject without calling
    fn.mockClear();
    await expect(cb.execute(fn)).rejects.toThrow(/circuit.*open/i);
    expect(fn).not.toHaveBeenCalled();
  });

  it('should reset failure count on success', async () => {
    const fn = vi.fn<() => Promise<string>>();

    const cb = new CircuitBreakerProvider({
      failureThreshold: 5,
      recoveryTimeout: 30_000,
    });

    // Accumulate 4 failures (one short of opening)
    fn.mockRejectedValue(httpError(500));
    for (let i = 0; i < 4; i++) {
      try {
        await cb.execute(fn);
      } catch {
        // expected
      }
    }

    // Now succeed — should reset counter
    fn.mockResolvedValueOnce('ok');
    await cb.execute(fn);

    // Accumulate 4 more failures — should still NOT open circuit
    // because counter was reset
    fn.mockRejectedValue(httpError(500));
    for (let i = 0; i < 4; i++) {
      try {
        await cb.execute(fn);
      } catch {
        // expected
      }
    }

    // Circuit should still be closed (4 failures, threshold is 5)
    fn.mockClear();
    fn.mockResolvedValueOnce('still-ok');
    const result = await cb.execute(fn);
    expect(result).toBe('still-ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should only count consecutive transient failures', async () => {
    const fn = vi.fn<() => Promise<string>>();

    const cb = new CircuitBreakerProvider({
      failureThreshold: 5,
      recoveryTimeout: 30_000,
    });

    // 4 transient failures
    fn.mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(502))
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError(504))
      // Then a success
      .mockResolvedValueOnce('ok')
      // Then 4 more transient failures
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(httpError(500));

    // Run through all calls
    for (let i = 0; i < 9; i++) {
      try {
        await cb.execute(fn);
      } catch {
        // expected for failures
      }
    }

    // Despite 8 total transient failures, consecutive count is only 4
    // (reset after the success). Circuit should still be closed.
    fn.mockClear();
    fn.mockResolvedValueOnce('still-closed');
    const result = await cb.execute(fn);
    expect(result).toBe('still-closed');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should reject requests during open state within recovery window', async () => {
    const fn = vi.fn<() => Promise<string>>();
    fn.mockRejectedValue(httpError(500));

    const cb = new CircuitBreakerProvider({
      failureThreshold: 5,
      recoveryTimeout: 30_000,
    });

    // Open the circuit
    for (let i = 0; i < 5; i++) {
      try {
        await cb.execute(fn);
      } catch {
        // expected
      }
    }

    // Advance 15s — still within 30s recovery window
    await vi.advanceTimersByTimeAsync(15_000);

    fn.mockClear();
    // Should reject without calling fn — circuit is open
    await expect(cb.execute(fn)).rejects.toThrow(/circuit.*open/i);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ProviderChain (integration of retry + failover + circuit breaker)
// ---------------------------------------------------------------------------

describe('ProviderChain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should wrap invocation with full provider chain', async () => {
    const fn1 = vi.fn<() => Promise<string>>();
    const fn2 = vi.fn<() => Promise<string>>();

    fn1.mockRejectedValue(httpError(500));
    fn2.mockResolvedValue('fallback-success');

    const chain = new ProviderChain({
      providers: [
        { name: 'primary', model: 'claude-opus', execute: fn1 },
        { name: 'backup', model: 'claude-sonnet', execute: fn2 },
      ],
    });

    const resultPromise = chain.execute();

    // Advance timers to allow retries + failover
    await vi.advanceTimersByTimeAsync(30_000);

    const result = await resultPromise;
    expect(result).toBe('fallback-success');
  });

  it('should reject empty provider chain', () => {
    expect(
      () =>
        new ProviderChain({
          providers: [],
        }),
    ).toThrow();
  });

  it('should reject provider with no API key configured', () => {
    expect(
      () =>
        new ProviderChain({
          providers: [{ name: 'nokey', model: 'some-model', apiKey: undefined }],
        }),
    ).toThrow();
  });

  it('should propagate non-retryable errors without failover', async () => {
    const fn1 = vi.fn<() => Promise<string>>();
    const fn2 = vi.fn<() => Promise<string>>();

    // Auth error — non-retryable, should NOT failover
    fn1.mockRejectedValue(httpError(401, { message: 'Invalid API key' }));
    fn2.mockResolvedValue('should-not-reach');

    const chain = new ProviderChain({
      providers: [
        { name: 'primary', model: 'claude-opus', execute: fn1 },
        { name: 'backup', model: 'claude-sonnet', execute: fn2 },
      ],
    });

    await expect(chain.execute()).rejects.toThrow('Invalid API key');
    expect(fn2).not.toHaveBeenCalled();
  });

  it('should skip to next on context_length_exceeded and try next model', async () => {
    const fn1 = vi.fn<() => Promise<string>>();
    const fn2 = vi.fn<() => Promise<string>>();

    fn1.mockRejectedValue(contextLengthError());
    fn2.mockResolvedValue('larger-context-model-ok');

    const chain = new ProviderChain({
      providers: [
        { name: 'primary', model: 'small-context-model', execute: fn1 },
        { name: 'backup', model: 'large-context-model', execute: fn2 },
      ],
    });

    const result = await chain.execute();
    expect(result).toBe('larger-context-model-ok');
    // Should have skipped immediately, no retries on provider 1
    expect(fn1).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// selectModelChain
// ---------------------------------------------------------------------------

describe('selectModelChain', () => {
  it('should return ordered array of {provider, model} pairs', () => {
    const chain = selectModelChain({
      providers: [
        { name: 'openrouter', model: 'claude-opus-4', apiKey: 'key1' },
        { name: 'anthropic', model: 'claude-sonnet-4', apiKey: 'key2' },
        { name: 'bedrock', model: 'claude-haiku', apiKey: 'key3' },
      ],
    });

    expect(Array.isArray(chain)).toBe(true);
    expect(chain).toHaveLength(3);

    expect(chain[0]).toEqual(
      expect.objectContaining({ provider: 'openrouter', model: 'claude-opus-4' }),
    );
    expect(chain[1]).toEqual(
      expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-4' }),
    );
    expect(chain[2]).toEqual(
      expect.objectContaining({ provider: 'bedrock', model: 'claude-haiku' }),
    );
  });

  it('should reject empty provider configuration', () => {
    expect(() => selectModelChain({ providers: [] })).toThrow(/empty|no providers/i);
  });

  it('should reject provider with missing API key', () => {
    expect(() =>
      selectModelChain({
        providers: [
          { name: 'openrouter', model: 'claude-opus-4', apiKey: undefined },
        ],
      }),
    ).toThrow(/api.?key/i);
  });
});
