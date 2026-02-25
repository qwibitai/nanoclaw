export interface BackoffConfig {
  baseDelay: number;
  factor: number;
  jitterPercent: number;
  maxAttempts: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelay: 5000,
  factor: 2,
  jitterPercent: 0.2,
  maxAttempts: 5,
};

function clampRandom(randomValue: number): number {
  if (!Number.isFinite(randomValue)) return 0.5;
  if (randomValue < 0) return 0;
  if (randomValue > 1) return 1;
  return randomValue;
}

function resolveConfig(config?: BackoffConfig): BackoffConfig {
  if (!config) return DEFAULT_BACKOFF_CONFIG;

  return {
    baseDelay:
      Number.isFinite(config.baseDelay) && config.baseDelay > 0
        ? config.baseDelay
        : DEFAULT_BACKOFF_CONFIG.baseDelay,
    factor:
      Number.isFinite(config.factor) && config.factor >= 1
        ? config.factor
        : DEFAULT_BACKOFF_CONFIG.factor,
    jitterPercent:
      Number.isFinite(config.jitterPercent) &&
      config.jitterPercent >= 0 &&
      config.jitterPercent <= 1
        ? config.jitterPercent
        : DEFAULT_BACKOFF_CONFIG.jitterPercent,
    maxAttempts:
      Number.isFinite(config.maxAttempts) && config.maxAttempts >= 1
        ? Math.floor(config.maxAttempts)
        : DEFAULT_BACKOFF_CONFIG.maxAttempts,
  };
}

export function calculateBackoff(
  attempt: number,
  config?: BackoffConfig,
): { delay_ms: number; should_retry: boolean } {
  const resolved = resolveConfig(config);
  const normalizedAttempt =
    Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;

  if (normalizedAttempt > resolved.maxAttempts) {
    return { delay_ms: 0, should_retry: false };
  }

  const exponential =
    resolved.baseDelay * Math.pow(resolved.factor, normalizedAttempt - 1);
  const jitterWindow = exponential * resolved.jitterPercent;
  const jitterOffset = (clampRandom(Math.random()) * 2 - 1) * jitterWindow;
  const delayMs = Math.max(0, Math.round(exponential + jitterOffset));

  return { delay_ms: delayMs, should_retry: true };
}
