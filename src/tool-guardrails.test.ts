import { describe, it, expect } from 'vitest';

import {
  checkRateLimit,
  checkSpendLimit,
  RateLimiterState,
  SpendState,
  DEFAULT_RATE_LIMITS,
  DEFAULT_DAILY_SPEND_CAP_USD,
} from './tool-guardrails.js';

// ── Rate Limiter ─────────────────────────────────────────────────────

describe('checkRateLimit', () => {
  const windowMs = 3_600_000; // 1 hour
  const max = 3;

  it('allows first call with no prior state', () => {
    const result = checkRateLimit(undefined, max, windowMs, 1000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
    expect(result.newState.count).toBe(1);
  });

  it('allows calls within limit', () => {
    const state: RateLimiterState = { count: 1, windowStart: 1000 };
    const result = checkRateLimit(state, max, windowMs, 2000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
    expect(result.newState.count).toBe(2);
  });

  it('blocks when limit reached', () => {
    const state: RateLimiterState = { count: 3, windowStart: 1000 };
    const result = checkRateLimit(state, max, windowMs, 2000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('resets after window expires', () => {
    const state: RateLimiterState = { count: 3, windowStart: 1000 };
    const result = checkRateLimit(state, max, windowMs, 1000 + windowMs + 1);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
    expect(result.newState.count).toBe(1);
  });

  it('reports correct resetsIn time', () => {
    const state: RateLimiterState = { count: 3, windowStart: 1000 };
    const result = checkRateLimit(state, max, windowMs, 1000 + 600_000);
    expect(result.resetsIn).toBe(3_000_000); // 50 minutes left
  });

  it('handles exactly-at-limit edge case', () => {
    const state: RateLimiterState = { count: 2, windowStart: 1000 };
    const result = checkRateLimit(state, max, windowMs, 2000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0); // used the last one
  });

  it('blocks the call after last one', () => {
    // After using the last allowed call
    const state: RateLimiterState = { count: 3, windowStart: 1000 };
    const result = checkRateLimit(state, max, windowMs, 2000);
    expect(result.allowed).toBe(false);
  });

  it('default limits exist for send_sms and make_call', () => {
    expect(DEFAULT_RATE_LIMITS.send_sms).toBeDefined();
    expect(DEFAULT_RATE_LIMITS.send_sms.max).toBe(10);
    expect(DEFAULT_RATE_LIMITS.make_call).toBeDefined();
    expect(DEFAULT_RATE_LIMITS.make_call.max).toBe(5);
  });
});

// ── Spend Tracker ────────────────────────────────────────────────────

describe('checkSpendLimit', () => {
  const cap = 10; // $10/day

  it('allows first spend with no prior state', () => {
    const result = checkSpendLimit(undefined, 1.5, cap, 1000);
    expect(result.allowed).toBe(true);
    expect(result.totalToday).toBe(1.5);
    expect(result.remaining).toBe(8.5);
  });

  it('allows spend within cap', () => {
    const state: SpendState = { totalUsd: 3, dayStart: 1000 };
    const result = checkSpendLimit(state, 2, cap, 2000);
    expect(result.allowed).toBe(true);
    expect(result.totalToday).toBe(5);
    expect(result.remaining).toBe(5);
  });

  it('blocks when spend would exceed cap', () => {
    const state: SpendState = { totalUsd: 9, dayStart: 1000 };
    const result = checkSpendLimit(state, 2, cap, 2000);
    expect(result.allowed).toBe(false);
    expect(result.totalToday).toBe(9); // unchanged
    expect(result.remaining).toBe(1);
  });

  it('resets after 24 hours', () => {
    const state: SpendState = { totalUsd: 10, dayStart: 1000 };
    const result = checkSpendLimit(state, 1, cap, 1000 + 86_400_001);
    expect(result.allowed).toBe(true);
    expect(result.totalToday).toBe(1);
  });

  it('blocks single spend exceeding cap on new day', () => {
    const result = checkSpendLimit(undefined, 15, cap, 1000);
    expect(result.allowed).toBe(false);
  });

  it('allows spend exactly at cap', () => {
    const state: SpendState = { totalUsd: 5, dayStart: 1000 };
    const result = checkSpendLimit(state, 5, cap, 2000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it('blocks any spend when cap already hit', () => {
    const state: SpendState = { totalUsd: 10, dayStart: 1000 };
    const result = checkSpendLimit(state, 0.01, cap, 2000);
    expect(result.allowed).toBe(false);
  });

  it('default cap is $10', () => {
    expect(DEFAULT_DAILY_SPEND_CAP_USD).toBe(10);
  });
});
