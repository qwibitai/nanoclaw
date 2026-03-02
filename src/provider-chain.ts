/**
 * Provider Fallback Chain
 *
 * Resilient LLM call execution with retry, failover, and circuit breaking.
 */
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export interface ErrorClassification {
  retryable: boolean;
  transient: boolean;
  contextLength: boolean;
}

const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const NETWORK_TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
]);

export function classifyError(err: unknown): ErrorClassification {
  const error = err as Record<string, unknown>;
  const status = typeof error?.status === 'number' ? error.status : undefined;
  const code = typeof error?.code === 'string' ? error.code : undefined;

  // context_length_exceeded — skip to next provider, don't retry
  if (code === 'context_length_exceeded') {
    return { retryable: false, transient: false, contextLength: true };
  }

  // Network timeout errors
  if (code && NETWORK_TIMEOUT_CODES.has(code)) {
    return { retryable: true, transient: true, contextLength: false };
  }

  // Transient HTTP errors
  if (status !== undefined && TRANSIENT_STATUS_CODES.has(status)) {
    return { retryable: true, transient: true, contextLength: false };
  }

  // Everything else is non-retryable (401, 400, 422, etc.)
  return { retryable: false, transient: false, contextLength: false };
}

// ---------------------------------------------------------------------------
// RetryProvider
// ---------------------------------------------------------------------------

export interface RetryProviderOptions {
  maxRetries: number;
  baseDelay?: number; // ms, default 1000
  jitter?: number; // fraction, default 0.25
}

export class RetryProvider {
  private readonly maxRetries: number;
  private readonly baseDelay: number;
  private readonly jitter: number;

  constructor(opts: RetryProviderOptions) {
    this.maxRetries = opts.maxRetries;
    this.baseDelay = opts.baseDelay ?? 1000;
    this.jitter = opts.jitter ?? 0.25;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const classification = classifyError(err);

        // Non-retryable errors propagate immediately
        if (!classification.retryable) {
          throw err;
        }

        // Exhausted all retries
        if (attempt >= this.maxRetries) {
          throw err;
        }

        // Calculate delay
        const delay = this.calculateDelay(attempt, err);
        logger.debug(
          { attempt, delay, maxRetries: this.maxRetries },
          'Retrying after backoff',
        );
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  private calculateDelay(attempt: number, err: unknown): number {
    // Check for retry-after header
    const error = err as Record<string, unknown>;
    const headers = error?.headers as Record<string, string> | undefined;
    const retryAfter = headers?.['retry-after'];
    if (retryAfter !== undefined) {
      const seconds = Number(retryAfter);
      if (!isNaN(seconds) && seconds > 0) {
        // Clamp to [1s, 60s] to prevent indefinite hang or hot retry loop
        const clampedMs = Math.min(Math.max(seconds * 1000, 1000), 60_000);
        return clampedMs;
      }
    }

    // Exponential backoff: baseDelay * 2^attempt with jitter
    const base = this.baseDelay * Math.pow(2, attempt);
    const jitterRange = base * this.jitter;
    const jitterOffset = (Math.random() * 2 - 1) * jitterRange;
    return Math.max(0, base + jitterOffset);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ---------------------------------------------------------------------------
// FailoverProvider
// ---------------------------------------------------------------------------

export interface FailoverProviderEntry {
  name: string;
  execute: () => Promise<unknown>;
}

export interface FailoverProviderOptions {
  providers: FailoverProviderEntry[];
  failureThreshold: number;
  cooldownMs?: number; // default 60000
  maxTotalAttempts?: number; // default 15 — global call budget
}

interface ProviderState {
  failureCount: number;
  cooldownStartedAt: number | null;
}

export class FailoverProvider {
  private readonly providers: FailoverProviderEntry[];
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly maxTotalAttempts: number;
  private readonly state: Map<string, ProviderState> = new Map();

  constructor(opts: FailoverProviderOptions) {
    this.providers = opts.providers;
    this.failureThreshold = opts.failureThreshold;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.maxTotalAttempts = opts.maxTotalAttempts ?? 6;

    for (const p of this.providers) {
      this.state.set(p.name, { failureCount: 0, cooldownStartedAt: null });
    }
  }

  async execute(): Promise<unknown> {
    // Max iterations to prevent infinite loops
    const maxIterations = this.failureThreshold * this.providers.length + 1;
    let totalAttempts = 0;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      // Get available (non-cooled) providers
      const available = this.getAvailableProviders();

      if (available.length === 0) {
        // All in cooldown — try the oldest-cooled provider
        return this.tryOldestCooled();
      }

      for (const provider of available) {
        if (++totalAttempts > this.maxTotalAttempts) {
          throw new Error(
            'Provider chain budget exhausted — too many total attempts',
          );
        }
        const state = this.state.get(provider.name)!;
        try {
          const result = await provider.execute();
          // Success — reset
          state.failureCount = 0;
          state.cooldownStartedAt = null;
          return result;
        } catch (err) {
          const classification = classifyError(err);

          // context_length_exceeded: skip to next provider immediately
          if (classification.contextLength) {
            continue;
          }

          // Non-retryable, non-transient: propagate immediately
          if (!classification.retryable && !classification.transient) {
            throw err;
          }

          // Transient failure: increment count
          state.failureCount++;
          logger.debug(
            {
              provider: provider.name,
              failureCount: state.failureCount,
              threshold: this.failureThreshold,
            },
            'Provider transient failure',
          );

          if (state.failureCount >= this.failureThreshold) {
            state.cooldownStartedAt = Date.now();
            logger.warn(
              { provider: provider.name },
              'Provider entered cooldown',
            );
          }

          // Continue to next provider in this iteration
          continue;
        }
      }
      // All available providers failed in this iteration — loop to re-evaluate
    }

    // If we get here, try oldest-cooled as last resort
    return this.tryOldestCooled();
  }

  private async tryOldestCooled(): Promise<unknown> {
    const oldest = this.getOldestCooledProvider();
    if (!oldest) {
      throw new Error('All providers exhausted');
    }

    const state = this.state.get(oldest.name)!;
    const result = await oldest.execute();
    state.failureCount = 0;
    state.cooldownStartedAt = null;
    return result;
  }

  private getAvailableProviders(): FailoverProviderEntry[] {
    const now = Date.now();
    return this.providers.filter((p) => {
      const state = this.state.get(p.name)!;
      if (state.cooldownStartedAt === null) return true;
      // Auto-recover if cooldown has expired
      if (now - state.cooldownStartedAt >= this.cooldownMs) {
        state.cooldownStartedAt = null;
        state.failureCount = 0;
        return true;
      }
      return false;
    });
  }

  private getOldestCooledProvider(): FailoverProviderEntry | null {
    let oldest: FailoverProviderEntry | null = null;
    let oldestTime = Infinity;

    for (const p of this.providers) {
      const state = this.state.get(p.name)!;
      if (
        state.cooldownStartedAt !== null &&
        state.cooldownStartedAt < oldestTime
      ) {
        oldestTime = state.cooldownStartedAt;
        oldest = p;
      }
    }

    return oldest;
  }
}

// ---------------------------------------------------------------------------
// CircuitBreakerProvider
// ---------------------------------------------------------------------------

type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  recoveryTimeout: number; // ms
}

export class CircuitBreakerProvider {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly recoveryTimeout: number;

  constructor(opts: CircuitBreakerOptions) {
    this.failureThreshold = opts.failureThreshold;
    this.recoveryTimeout = opts.recoveryTimeout;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      // Check if recovery timeout has elapsed
      if (Date.now() - this.openedAt >= this.recoveryTimeout) {
        this.state = 'half-open';
        logger.debug('Circuit breaker entering half-open state');
      } else {
        throw new Error('Circuit is open');
      }
    }

    try {
      const result = await fn();
      // Success: reset
      this.consecutiveFailures = 0;
      if (this.state === 'half-open') {
        this.state = 'closed';
        logger.info('Circuit breaker closed after successful probe');
      }
      return result;
    } catch (err) {
      const classification = classifyError(err);

      if (classification.transient) {
        this.consecutiveFailures++;
        logger.debug(
          {
            consecutiveFailures: this.consecutiveFailures,
            threshold: this.failureThreshold,
          },
          'Circuit breaker transient failure',
        );

        if (this.state === 'half-open') {
          // Probe failed — reopen
          this.state = 'open';
          this.openedAt = Date.now();
          logger.warn('Circuit breaker reopened after failed probe');
        } else if (this.consecutiveFailures >= this.failureThreshold) {
          this.state = 'open';
          this.openedAt = Date.now();
          logger.warn(
            { threshold: this.failureThreshold },
            'Circuit breaker opened',
          );
        }
      }

      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// ProviderChain
// ---------------------------------------------------------------------------

export interface ProviderChainEntry {
  name: string;
  model: string;
  execute?: () => Promise<unknown>;
  apiKey?: string;
}

export interface ProviderChainOptions {
  providers: ProviderChainEntry[];
  maxRetries?: number;
  maxTotalAttempts?: number;
  failureThreshold?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerRecoveryTimeout?: number;
}

export class ProviderChain {
  private readonly failover: FailoverProvider;

  constructor(opts: ProviderChainOptions) {
    if (opts.providers.length === 0) {
      throw new Error('Provider chain cannot be empty');
    }

    // Validate: providers without execute must have apiKey
    for (const p of opts.providers) {
      if (!p.execute && !p.apiKey) {
        throw new Error(`Provider "${p.name}" has no API key configured`);
      }
    }

    const maxRetries = opts.maxRetries ?? 3;
    const failureThreshold = opts.failureThreshold ?? 3;

    // Build failover entries: wrap each provider's execute with retry + circuit breaker
    const failoverEntries: FailoverProviderEntry[] = opts.providers.map((p) => {
      const retry = new RetryProvider({ maxRetries });
      const cb = new CircuitBreakerProvider({
        failureThreshold: opts.circuitBreakerThreshold ?? 5,
        recoveryTimeout: opts.circuitBreakerRecoveryTimeout ?? 30_000,
      });

      const executeFn =
        p.execute ??
        (() => Promise.reject(new Error(`No execute function for ${p.name}`)));

      return {
        name: p.name,
        execute: () => cb.execute(() => retry.execute(executeFn)),
      };
    });

    this.failover = new FailoverProvider({
      providers: failoverEntries,
      failureThreshold,
      maxTotalAttempts: opts.maxTotalAttempts,
    });
  }

  async execute(): Promise<unknown> {
    return this.failover.execute();
  }
}

// ---------------------------------------------------------------------------
// selectModelChain
// ---------------------------------------------------------------------------

export interface ModelChainConfig {
  providers: Array<{
    name: string;
    model: string;
    apiKey?: string;
  }>;
}

export interface ModelChainEntry {
  provider: string;
  model: string;
}

export function selectModelChain(config: ModelChainConfig): ModelChainEntry[] {
  if (config.providers.length === 0) {
    throw new Error('No providers configured — provider chain is empty');
  }

  for (const p of config.providers) {
    if (!p.apiKey) {
      throw new Error(`Provider "${p.name}" has no API key configured`);
    }
  }

  return config.providers.map((p) => ({
    provider: p.name,
    model: p.model,
  }));
}
