import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  CircuitState,
  getChannelHealth,
  recordSuccess,
  recordFailure,
  shouldSkipChannel,
  connectWithBackoff,
  backoffDelay,
  _resetHealth,
} from './circuit-breaker.js';

beforeEach(() => {
  _resetHealth();
  vi.restoreAllMocks();
});

describe('circuit-breaker', () => {
  describe('getChannelHealth', () => {
    it('returns CLOSED state with defaults for a new channel', () => {
      const health = getChannelHealth('test-ch');
      expect(health.state).toBe(CircuitState.CLOSED);
      expect(health.consecutiveFailures).toBe(0);
      expect(health.lastFailureAt).toBeNull();
      expect(health.lastSuccessAt).toBeNull();
      expect(health.config.baseDelay).toBe(1000);
      expect(health.config.multiplier).toBe(2);
      expect(health.config.maxDelay).toBe(60_000);
      expect(health.config.maxAttempts).toBe(5);
      expect(health.config.cooldownMs).toBe(120_000);
    });

    it('accepts config overrides', () => {
      const health = getChannelHealth('test-ch', { maxAttempts: 3, baseDelay: 500 });
      expect(health.config.maxAttempts).toBe(3);
      expect(health.config.baseDelay).toBe(500);
      expect(health.config.multiplier).toBe(2); // default preserved
    });

    it('returns the same instance on subsequent calls', () => {
      const h1 = getChannelHealth('test-ch');
      const h2 = getChannelHealth('test-ch');
      expect(h1).toBe(h2);
    });
  });

  describe('backoffDelay', () => {
    it('calculates exponential delays', () => {
      const health = getChannelHealth('test-ch', { baseDelay: 1000, multiplier: 2, maxDelay: 60_000 });
      health.consecutiveFailures = 0;
      expect(backoffDelay(health)).toBe(1000);
      health.consecutiveFailures = 1;
      expect(backoffDelay(health)).toBe(2000);
      health.consecutiveFailures = 2;
      expect(backoffDelay(health)).toBe(4000);
      health.consecutiveFailures = 3;
      expect(backoffDelay(health)).toBe(8000);
    });

    it('caps at maxDelay', () => {
      const health = getChannelHealth('test-ch', { baseDelay: 1000, multiplier: 2, maxDelay: 10_000 });
      health.consecutiveFailures = 10;
      expect(backoffDelay(health)).toBe(10_000);
    });
  });

  describe('recordSuccess', () => {
    it('resets state to CLOSED and clears failure count', () => {
      const health = getChannelHealth('test-ch');
      health.state = CircuitState.HALF_OPEN;
      health.consecutiveFailures = 3;
      recordSuccess('test-ch');
      expect(health.state).toBe(CircuitState.CLOSED);
      expect(health.consecutiveFailures).toBe(0);
      expect(health.lastSuccessAt).toBeTypeOf('number');
    });
  });

  describe('recordFailure', () => {
    it('increments failure count', () => {
      const health = getChannelHealth('test-ch');
      recordFailure('test-ch');
      expect(health.consecutiveFailures).toBe(1);
      expect(health.lastFailureAt).toBeTypeOf('number');
    });

    it('trips circuit after max attempts', () => {
      const health = getChannelHealth('test-ch', { maxAttempts: 3 });
      recordFailure('test-ch');
      recordFailure('test-ch');
      expect(health.state).toBe(CircuitState.CLOSED);
      recordFailure('test-ch');
      expect(health.state).toBe(CircuitState.OPEN);
    });

    it('transitions HALF_OPEN → OPEN on probe failure', () => {
      const health = getChannelHealth('test-ch');
      health.state = CircuitState.HALF_OPEN;
      recordFailure('test-ch');
      expect(health.state).toBe(CircuitState.OPEN);
    });
  });

  describe('shouldSkipChannel', () => {
    it('returns false for CLOSED channels', () => {
      getChannelHealth('test-ch');
      expect(shouldSkipChannel('test-ch')).toBe(false);
    });

    it('returns false for HALF_OPEN channels (allow probe)', () => {
      const health = getChannelHealth('test-ch');
      health.state = CircuitState.HALF_OPEN;
      expect(shouldSkipChannel('test-ch')).toBe(false);
    });

    it('returns true for OPEN channels within cooldown', () => {
      const health = getChannelHealth('test-ch', { cooldownMs: 120_000 });
      health.state = CircuitState.OPEN;
      health.lastFailureAt = Date.now();
      expect(shouldSkipChannel('test-ch')).toBe(true);
    });

    it('transitions OPEN → HALF_OPEN after cooldown', () => {
      const health = getChannelHealth('test-ch', { cooldownMs: 1000 });
      health.state = CircuitState.OPEN;
      health.lastFailureAt = Date.now() - 2000; // past cooldown
      expect(shouldSkipChannel('test-ch')).toBe(false);
      expect(health.state).toBe(CircuitState.HALF_OPEN);
    });

    it('returns false for unknown channels', () => {
      expect(shouldSkipChannel('nonexistent')).toBe(false);
    });
  });

  describe('connectWithBackoff', () => {
    it('succeeds on first try', async () => {
      const connectFn = vi.fn().mockResolvedValue(undefined);
      const result = await connectWithBackoff('test-ch', connectFn, {
        maxAttempts: 3,
        baseDelay: 1,
      });
      expect(result).toBe(true);
      expect(connectFn).toHaveBeenCalledTimes(1);
      const health = getChannelHealth('test-ch');
      expect(health.state).toBe(CircuitState.CLOSED);
      expect(health.consecutiveFailures).toBe(0);
    });

    it('retries on transient failures then succeeds', async () => {
      const connectFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue(undefined);

      const result = await connectWithBackoff('test-ch', connectFn, {
        maxAttempts: 5,
        baseDelay: 1,
        multiplier: 1,
        maxDelay: 1,
      });
      expect(result).toBe(true);
      expect(connectFn).toHaveBeenCalledTimes(3);
      const health = getChannelHealth('test-ch');
      expect(health.state).toBe(CircuitState.CLOSED);
    });

    it('trips circuit after max failures', async () => {
      const connectFn = vi.fn().mockRejectedValue(new Error('always fails'));

      const result = await connectWithBackoff('test-ch', connectFn, {
        maxAttempts: 3,
        baseDelay: 1,
        multiplier: 1,
        maxDelay: 1,
      });
      expect(result).toBe(false);
      const health = getChannelHealth('test-ch');
      expect(health.state).toBe(CircuitState.OPEN);
      expect(health.consecutiveFailures).toBe(3);
    });

    it('skips OPEN channel within cooldown', async () => {
      const health = getChannelHealth('test-ch', { cooldownMs: 120_000 });
      health.state = CircuitState.OPEN;
      health.lastFailureAt = Date.now();

      const connectFn = vi.fn();
      const result = await connectWithBackoff('test-ch', connectFn);
      expect(result).toBe(false);
      expect(connectFn).not.toHaveBeenCalled();
    });

    it('allows single probe in HALF_OPEN and recovers on success', async () => {
      const health = getChannelHealth('test-ch', { cooldownMs: 1, baseDelay: 1 });
      health.state = CircuitState.OPEN;
      health.lastFailureAt = Date.now() - 100; // past cooldown
      health.consecutiveFailures = 5;

      const connectFn = vi.fn().mockResolvedValue(undefined);
      const result = await connectWithBackoff('test-ch', connectFn);
      expect(result).toBe(true);
      expect(connectFn).toHaveBeenCalledTimes(1);
      expect(health.state).toBe(CircuitState.CLOSED);
      expect(health.consecutiveFailures).toBe(0);
    });

    it('re-opens circuit on failed HALF_OPEN probe', async () => {
      const health = getChannelHealth('test-ch', { cooldownMs: 1, baseDelay: 1 });
      health.state = CircuitState.OPEN;
      health.lastFailureAt = Date.now() - 100;
      health.consecutiveFailures = 5;

      const connectFn = vi.fn().mockRejectedValue(new Error('probe fail'));
      const result = await connectWithBackoff('test-ch', connectFn);
      expect(result).toBe(false);
      expect(connectFn).toHaveBeenCalledTimes(1); // only one probe
      expect(health.state).toBe(CircuitState.OPEN);
    });
  });
});
