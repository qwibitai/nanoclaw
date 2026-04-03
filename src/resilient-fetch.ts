/**
 * Resilient HTTP fetch with timeouts, retries, and circuit breaker integration.
 *
 * Drop-in replacement for fetch() that prevents hanging requests and retries
 * transient failures. Builds on the proven fetchRetry pattern from tools/iddi
 * and integrates with the existing CircuitBreaker from circuit-breaker.ts.
 */
import { CircuitBreaker } from './circuit-breaker.js';
import { logger } from './logger.js';

export interface ResilientFetchOptions {
  /** Per-attempt timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Number of retries after the first attempt (default 2 = 3 total). */
  retries?: number;
  /** Base delay for exponential backoff in ms (default 1_000). */
  backoffBaseMs?: number;
  /** Optional circuit breaker — wraps the entire retry loop. */
  breaker?: CircuitBreaker;
  /** Custom predicate for retryable HTTP status codes. Default: 429, 500-504. */
  retryOn?: (status: number) => boolean;
  /** Label for logging (e.g. 'square-api', 'messenger'). Defaults to URL hostname. */
  label?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 1_000;

function defaultRetryOn(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 504);
}

function backoffWithJitter(baseMs: number, attempt: number): number {
  const delay = baseMs * 2 ** attempt;
  const jitter = delay * 0.25 * (2 * Math.random() - 1); // ±25%
  return Math.max(0, Math.round(delay + jitter));
}

/**
 * Fetch with timeout, retries, and optional circuit breaker.
 * Only retries on transient errors (network failures, 429, 5xx).
 * Permanent errors (400, 401, 404, 422) fail immediately.
 */
export async function resilientFetch(
  url: string,
  init?: RequestInit,
  opts?: ResilientFetchOptions,
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts?.retries ?? DEFAULT_RETRIES;
  const backoffBaseMs = opts?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const retryOn = opts?.retryOn ?? defaultRetryOn;
  const label = opts?.label ?? new URL(url).hostname;

  const doFetch = async (): Promise<Response> => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
        });

        // Don't retry permanent client errors
        if (!res.ok && !retryOn(res.status)) {
          return res;
        }

        // Retry on retryable status codes
        if (!res.ok && retryOn(res.status) && attempt < retries) {
          const delay = backoffWithJitter(backoffBaseMs, attempt);
          logger.debug(
            { label, status: res.status, attempt: attempt + 1, retries, delay },
            'Retryable HTTP status, backing off',
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        return res;
      } catch (err) {
        if (attempt === retries) {
          logger.warn(
            { label, attempt: attempt + 1, err },
            'All fetch attempts exhausted',
          );
          throw err;
        }
        const delay = backoffWithJitter(backoffBaseMs, attempt);
        logger.debug(
          { label, attempt: attempt + 1, retries, delay, err },
          'Fetch error, retrying',
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error('unreachable');
  };

  if (opts?.breaker) {
    return opts.breaker.call(doFetch);
  }
  return doFetch();
}
