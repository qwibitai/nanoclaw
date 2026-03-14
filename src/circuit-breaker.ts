/**
 * Lightweight circuit breaker with exponential backoff and jitter.
 * States: closed (normal), open (failing, reject calls), half-open (testing recovery).
 */
import { logger } from './logger.js';

export interface CircuitBreakerOpts {
  maxFailures?: number;
  resetMs?: number;
  maxBackoffMs?: number;
}

export class CircuitBreaker {
  private readonly name: string;
  private readonly maxFailures: number;
  private readonly resetMs: number;
  private readonly maxBackoffMs: number;

  private failures = 0;
  private lastFailureAt = 0;
  private _state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(name: string, opts?: CircuitBreakerOpts) {
    this.name = name;
    this.maxFailures = opts?.maxFailures ?? 5;
    this.resetMs = opts?.resetMs ?? 60_000;
    this.maxBackoffMs = opts?.maxBackoffMs ?? 300_000;
  }

  get state(): 'closed' | 'open' | 'half-open' {
    if (this._state === 'open' && Date.now() - this.lastFailureAt >= this.resetMs) {
      this._state = 'half-open';
    }
    return this._state;
  }

  /** Exponential backoff (2^failures * 1s base) with ±25% jitter. */
  get backoffMs(): number {
    const base = Math.min(2 ** this.failures * 1000, this.maxBackoffMs);
    const jitter = base * 0.25 * (2 * Math.random() - 1); // ±25%
    return Math.max(0, Math.round(base + jitter));
  }

  /** Wrap an async operation. Throws if circuit is open. Tracks failures/successes. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.state;
    if (current === 'open') {
      throw new Error(`Circuit breaker "${this.name}" is open (${this.failures} failures, backoff ${this.backoffMs}ms)`);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.failures > 0) {
      logger.info({ breaker: this.name, prevFailures: this.failures }, 'Circuit breaker recovered');
    }
    this.failures = 0;
    this._state = 'closed';
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureAt = Date.now();
    if (this.failures >= this.maxFailures) {
      this._state = 'open';
      logger.warn(
        { breaker: this.name, failures: this.failures, resetMs: this.resetMs },
        'Circuit breaker opened',
      );
    }
  }
}
