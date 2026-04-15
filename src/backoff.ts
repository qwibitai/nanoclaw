export interface ExponentialBackoffConfig {
  baseDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
}

export function calculateExponentialBackoffDelay(
  retryCount: number,
  config: ExponentialBackoffConfig,
): number {
  const normalizedRetryCount = Math.max(1, retryCount);
  const delay =
    config.baseDelayMs * Math.pow(config.multiplier, normalizedRetryCount - 1);
  return Math.min(delay, config.maxDelayMs);
}

export function calculateDispatchBackoffSkips(retryCount: number): number {
  if (retryCount <= 0 || retryCount >= 3) {
    return 0;
  }

  return Math.pow(2, retryCount) - 1;
}
