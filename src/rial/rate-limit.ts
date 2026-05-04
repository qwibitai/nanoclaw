/**
 * Per-phone token-bucket rate limiter.
 *
 * In-memory only — restarts reset all buckets, which is fine for V1
 * (limit is per minute). Key is the wa_phone (or whatever the caller
 * uses to identify a sender).
 *
 * Defaults: 30 tokens / min, burst capacity 10.
 *
 * Empty buckets are pruned once their refill timestamp passes the
 * current second, which keeps memory bounded under abuse without
 * needing a sweep.
 */

export interface RateLimitOptions {
  /** Sustained refill rate in requests per minute. */
  perMinute?: number;
  /** Maximum burst capacity. Defaults to perMinute / 3. */
  burst?: number;
  now?: () => number;
}

interface Bucket {
  /** Current token count (float — refills are continuous). */
  tokens: number;
  /** Last update wall-clock millis. */
  lastRefill: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the next request would be allowed. 0 when allowed=true. */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: RateLimitOptions = {}) {
    const perMinute = opts.perMinute ?? 30;
    const burst = opts.burst ?? Math.max(1, Math.ceil(perMinute / 3));
    this.capacity = burst;
    this.refillPerMs = perMinute / 60_000;
    this.now = opts.now ?? Date.now;
  }

  check(key: string): RateLimitResult {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = now - bucket.lastRefill;
      if (elapsed > 0) {
        bucket.tokens = Math.min(
          this.capacity,
          bucket.tokens + elapsed * this.refillPerMs,
        );
        bucket.lastRefill = now;
      }
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const tokensNeeded = 1 - bucket.tokens;
    const msUntilOne = tokensNeeded / this.refillPerMs;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(msUntilOne / 1000)),
    };
  }

  /** Test-only / shutdown helper. */
  reset(): void {
    this.buckets.clear();
  }
}

// Module-level singleton — handleRialMessage uses this directly. Tests
// instantiate RateLimiter manually so they don't share state.
let defaultLimiter: RateLimiter | null = null;
export function getDefaultRateLimiter(): RateLimiter {
  if (!defaultLimiter) defaultLimiter = new RateLimiter();
  return defaultLimiter;
}
export function resetDefaultRateLimiter(): void {
  defaultLimiter = null;
}
