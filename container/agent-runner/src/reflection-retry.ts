/**
 * Transient error classification and single-retry with jitter
 * for reflection operations.
 *
 * Ported from memory-lancedb-pro.
 */

// ============================================================================
// Error Classification
// ============================================================================

/** Errors that are safe to retry (transient network/service issues) */
const TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /network/i,
  /socket\s+hang\s+up/i,
  /429/,           // rate limit
  /503/,           // service unavailable
  /502/,           // bad gateway
  /500/,           // internal server error (sometimes transient)
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
];

/**
 * Check if an error is transient (safe to retry).
 */
export function isTransientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some(pattern => pattern.test(message));
}

// ============================================================================
// Retry Logic
// ============================================================================

/**
 * Execute an async function with a single retry on transient errors.
 * Uses jittered delay to avoid thundering herd.
 *
 * @param fn - The async function to execute
 * @param label - A label for logging
 * @param baseDelayMs - Base delay before retry (default: 1000ms)
 * @returns The result of fn, or throws on non-transient error
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  baseDelayMs: number = 1000,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientError(err)) {
      throw err; // Non-transient: don't retry
    }

    // Jittered delay: base ± 50%
    const jitter = baseDelayMs * (0.5 + Math.random());
    console.warn(`[reflection-retry] ${label}: transient error, retrying in ${Math.round(jitter)}ms: ${err instanceof Error ? err.message : String(err)}`);

    await sleep(jitter);

    // Single retry — if it fails again, let it throw
    return await fn();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
