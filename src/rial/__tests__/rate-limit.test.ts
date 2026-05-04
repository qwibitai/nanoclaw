import { describe, expect, it } from 'vitest';

import { RateLimiter } from '../rate-limit.js';

describe('RateLimiter', () => {
  it('allows the configured burst before blocking', () => {
    const now = 0;
    const limiter = new RateLimiter({
      perMinute: 30,
      burst: 10,
      now: () => now,
    });
    for (let i = 0; i < 10; i++) {
      const r = limiter.check('+54911');
      expect(r.allowed).toBe(true);
    }
    const blocked = limiter.check('+54911');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refills at the configured per-minute rate', () => {
    let now = 0;
    const limiter = new RateLimiter({
      perMinute: 60,
      burst: 5,
      now: () => now,
    });
    // Drain the burst.
    for (let i = 0; i < 5; i++) limiter.check('+54911');
    expect(limiter.check('+54911').allowed).toBe(false);
    // Advance 1.1s — at 60/min that's just over 1 token.
    now += 1100;
    expect(limiter.check('+54911').allowed).toBe(true);
    // No further tokens immediately.
    expect(limiter.check('+54911').allowed).toBe(false);
  });

  it('caps refill at burst capacity', () => {
    let now = 0;
    const limiter = new RateLimiter({
      perMinute: 30,
      burst: 10,
      now: () => now,
    });
    limiter.check('+54911'); // bucket exists, 9 tokens left.
    now += 60 * 60 * 1000; // 1 hour later — refill would be 1800 tokens.
    // Burst is capped at 10 → can drain exactly 10 in a row.
    for (let i = 0; i < 10; i++) {
      expect(limiter.check('+54911').allowed).toBe(true);
    }
    expect(limiter.check('+54911').allowed).toBe(false);
  });

  it('keeps independent buckets per key', () => {
    const now = 0;
    const limiter = new RateLimiter({
      perMinute: 30,
      burst: 2,
      now: () => now,
    });
    expect(limiter.check('+5491100000001').allowed).toBe(true);
    expect(limiter.check('+5491100000001').allowed).toBe(true);
    expect(limiter.check('+5491100000001').allowed).toBe(false);
    // Different number → fresh bucket.
    expect(limiter.check('+5491100000002').allowed).toBe(true);
    expect(limiter.check('+5491100000002').allowed).toBe(true);
    expect(limiter.check('+5491100000002').allowed).toBe(false);
  });

  it('reports a sane retryAfter when blocked', () => {
    const now = 0;
    const limiter = new RateLimiter({
      perMinute: 60,
      burst: 1,
      now: () => now,
    });
    expect(limiter.check('+54911').allowed).toBe(true);
    const blocked = limiter.check('+54911');
    expect(blocked.allowed).toBe(false);
    // 60/min = 1/sec → next token in ~1s, with the clamp to >=1s.
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(2);
  });

  it('reset clears all buckets', () => {
    const now = 0;
    const limiter = new RateLimiter({
      perMinute: 30,
      burst: 1,
      now: () => now,
    });
    limiter.check('+54911');
    expect(limiter.check('+54911').allowed).toBe(false);
    limiter.reset();
    expect(limiter.check('+54911').allowed).toBe(true);
  });
});
