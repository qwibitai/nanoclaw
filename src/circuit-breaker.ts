import { logger } from './logger.js';

// --- Circuit Breaker Types ---

export enum CircuitState {
  CLOSED = 'CLOSED', // Healthy — allow all attempts
  OPEN = 'OPEN', // Tripped — skip attempts until cooldown
  HALF_OPEN = 'HALF_OPEN', // Probing — allow one test attempt
}

export interface CircuitBreakerConfig {
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelay: number;
  /** Multiplier for exponential backoff (default: 2) */
  multiplier: number;
  /** Maximum delay in ms (default: 60000) */
  maxDelay: number;
  /** Max consecutive failures before opening circuit (default: 5) */
  maxAttempts: number;
  /** Cooldown in ms before transitioning OPEN → HALF_OPEN (default: 120000) */
  cooldownMs: number;
}

export interface ChannelHealth {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  config: CircuitBreakerConfig;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  baseDelay: 1000,
  multiplier: 2,
  maxDelay: 60_000,
  maxAttempts: 5,
  cooldownMs: 120_000,
};

// Per-channel health state
const healthMap = new Map<string, ChannelHealth>();

/** Get or create health state for a channel */
export function getChannelHealth(
  channelName: string,
  overrides?: Partial<CircuitBreakerConfig>,
): ChannelHealth {
  let health = healthMap.get(channelName);
  if (!health) {
    health = {
      state: CircuitState.CLOSED,
      consecutiveFailures: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
      config: { ...DEFAULT_CONFIG, ...overrides },
    };
    healthMap.set(channelName, health);
  }
  return health;
}

/** Calculate backoff delay for the current failure count */
export function backoffDelay(health: ChannelHealth): number {
  const { baseDelay, multiplier, maxDelay } = health.config;
  const delay = baseDelay * Math.pow(multiplier, health.consecutiveFailures);
  return Math.min(delay, maxDelay);
}

/** Record a successful connection — reset to CLOSED */
export function recordSuccess(channelName: string): void {
  const health = healthMap.get(channelName);
  if (!health) return;

  const prev = health.state;
  health.state = CircuitState.CLOSED;
  health.consecutiveFailures = 0;
  health.lastSuccessAt = Date.now();

  if (prev === CircuitState.HALF_OPEN) {
    logger.info(
      { channel: channelName, transition: 'HALF_OPEN→CLOSED', event: 'circuit_breaker' },
      'Circuit breaker recovered — probe succeeded',
    );
  } else if (prev === CircuitState.OPEN) {
    // Shouldn't normally happen, but log it
    logger.info(
      { channel: channelName, transition: 'OPEN→CLOSED', event: 'circuit_breaker' },
      'Circuit breaker reset',
    );
  }
}

/** Record a failure — may trip the circuit */
export function recordFailure(channelName: string, error?: unknown): void {
  const health = healthMap.get(channelName);
  if (!health) return;

  health.consecutiveFailures++;
  health.lastFailureAt = Date.now();

  if (health.state === CircuitState.HALF_OPEN) {
    // Probe failed — back to OPEN
    health.state = CircuitState.OPEN;
    logger.warn(
      { channel: channelName, transition: 'HALF_OPEN→OPEN', event: 'circuit_breaker', err: error },
      'Circuit breaker probe failed — re-opening circuit',
    );
  } else if (
    health.state === CircuitState.CLOSED &&
    health.consecutiveFailures >= health.config.maxAttempts
  ) {
    health.state = CircuitState.OPEN;
    logger.warn(
      {
        channel: channelName,
        transition: 'CLOSED→OPEN',
        event: 'circuit_breaker',
        failures: health.consecutiveFailures,
        err: error,
      },
      `Circuit breaker tripped after ${health.consecutiveFailures} consecutive failures`,
    );
  }
}

/**
 * Check if a channel should be skipped.
 * If OPEN and cooldown has elapsed, transitions to HALF_OPEN.
 * Returns true if the channel should be skipped (circuit is OPEN).
 */
export function shouldSkipChannel(channelName: string): boolean {
  const health = healthMap.get(channelName);
  if (!health) return false;

  if (health.state === CircuitState.CLOSED) return false;
  if (health.state === CircuitState.HALF_OPEN) return false; // allow probe

  // OPEN — check cooldown
  if (health.lastFailureAt !== null) {
    const elapsed = Date.now() - health.lastFailureAt;
    if (elapsed >= health.config.cooldownMs) {
      health.state = CircuitState.HALF_OPEN;
      logger.info(
        { channel: channelName, transition: 'OPEN→HALF_OPEN', event: 'circuit_breaker', cooldownMs: health.config.cooldownMs },
        'Circuit breaker cooldown elapsed — probing',
      );
      return false; // allow probe attempt
    }
  }

  logger.debug(
    { channel: channelName, state: health.state, event: 'circuit_breaker' },
    'Skipping tripped channel',
  );
  return true; // skip
}

/**
 * Attempt to connect a channel with exponential backoff.
 * Respects the circuit breaker state.
 * Returns true if connection succeeded, false if skipped or all retries failed.
 */
export async function connectWithBackoff(
  channelName: string,
  connectFn: () => Promise<void>,
  configOverrides?: Partial<CircuitBreakerConfig>,
): Promise<boolean> {
  const health = getChannelHealth(channelName, configOverrides);

  if (shouldSkipChannel(channelName)) {
    return false;
  }

  const maxRetries =
    health.state === CircuitState.HALF_OPEN ? 1 : health.config.maxAttempts;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = backoffDelay(health);
      logger.info(
        { channel: channelName, attempt: attempt + 1, delayMs: delay, event: 'circuit_breaker' },
        `Retrying channel connect after ${delay}ms`,
      );
      await sleep(delay);
    }

    try {
      await connectFn();
      recordSuccess(channelName);
      return true;
    } catch (err) {
      recordFailure(channelName, err);

      // If circuit just opened (or probe failed), stop retrying
      if (health.state === CircuitState.OPEN) {
        return false;
      }
    }
  }

  return false;
}

/** Reset health state (for testing) */
export function _resetHealth(): void {
  healthMap.clear();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
