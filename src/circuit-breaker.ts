/**
 * Circuit Breaker for LM Studio / LLM connectivity
 *
 * Prevents hammering a failed endpoint by temporarily rejecting requests
 * after a threshold of consecutive failures.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit */
  failureThreshold: number;
  /** Time in ms before attempting to close the circuit */
  resetTimeoutMs: number;
  /** Maximum number of requests in HALF_OPEN state to test recovery */
  halfOpenMaxCalls: number;
}

const DEFAULT_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  resetTimeoutMs: 30000, // 30 seconds
  halfOpenMaxCalls: 3,
};

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private nextAttempt = 0;
  private halfOpenCalls = 0;
  private readonly options: CircuitBreakerOptions;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  getState(): CircuitState {
    if (this.state === 'OPEN') {
      // Check if it's time to transition to HALF_OPEN
      if (Date.now() >= this.nextAttempt) {
        this.state = 'HALF_OPEN';
        this.halfOpenCalls = 0;
        this.successCount = 0;
      }
    }
    return this.state;
  }

  /**
   * Execute a function with circuit breaker protection
   * Returns the result or throws CircuitBreakerError if circuit is open
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();

    if (state === 'OPEN') {
      const remainingMs = this.nextAttempt - Date.now();
      throw new CircuitBreakerError(
        `Circuit breaker is OPEN. Service temporarily unavailable. ` +
          `Retry after ${Math.ceil(remainingMs / 1000)}s.`,
        this.state,
        remainingMs,
      );
    }

    if (state === 'HALF_OPEN') {
      if (this.halfOpenCalls >= this.options.halfOpenMaxCalls) {
        throw new CircuitBreakerError(
          'Circuit breaker is HALF_OPEN. Testing in progress. Please retry shortly.',
          this.state,
          this.nextAttempt - Date.now(),
        );
      }
      this.halfOpenCalls++;
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
    this.failureCount = 0;

    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      // If we've had enough successes in half-open, close the circuit
      if (this.successCount >= this.options.halfOpenMaxCalls) {
        this.state = 'CLOSED';
        this.successCount = 0;
        this.halfOpenCalls = 0;
      }
    }
  }

  private onFailure(): void {
    this.failureCount++;

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.options.resetTimeoutMs;
      this.halfOpenCalls = 0;
      this.successCount = 0;
    }
  }

  forceOpen(reason: string): void {
    this.state = 'OPEN';
    this.failureCount = this.options.failureThreshold;
    this.nextAttempt = Date.now() + this.options.resetTimeoutMs;
    this.halfOpenCalls = 0;
    this.successCount = 0;
  }

  forceClose(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.halfOpenCalls = 0;
    this.successCount = 0;
  }

  getStats(): {
    state: CircuitState;
    failureCount: number;
    nextAttempt?: number;
  } {
    const state = this.getState();
    return {
      state,
      failureCount: this.failureCount,
      nextAttempt: state === 'OPEN' ? this.nextAttempt : undefined,
    };
  }
}

export class CircuitBreakerError extends Error {
  readonly state: CircuitState;
  readonly retryAfterMs: number;

  constructor(message: string, state: CircuitState, retryAfterMs: number) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.state = state;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Global circuit breaker for LM Studio connectivity
 */
export const lmStudioCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3, // Open after 3 consecutive failures
  resetTimeoutMs: 30000, // Try again after 30 seconds
  halfOpenMaxCalls: 2, // Allow 2 test calls in half-open state
});
