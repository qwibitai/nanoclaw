/**
 * Auth Circuit Breaker for NanoClaw
 *
 * Shared auth error detection + circuit breaker to prevent retry storms
 * when OAuth tokens expire or become invalid.
 *
 * Docs map:
 * - docs/SECURITY.md#6-auth-resilience-controls
 * - docs/SPEC.md#scheduled-tasks
 */
import { logger } from "./logger.js";

// --- Auth error detection ---

const AUTH_ERROR_PATTERNS = [
  "401",
  "unauthorized",
  "authentication",
  "oauth token",
  "token expired",
  "invalid_grant",
  "access_denied",
];

/**
 * Check if a string contains auth-related error patterns.
 * Single source of truth — used by circuit breaker, task-scheduler auto-pause,
 * and streaming callback suppression.
 */
export function isAuthError(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

// --- Circuit breaker ---

const MAX_FAILURES = 3;
const RESET_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

let consecutiveFailures = 0;
let circuitOpenSince: number | null = null;

export function recordAuthFailure(): void {
  consecutiveFailures++;
  logger.warn({ consecutiveFailures, max: MAX_FAILURES }, "Auth failure recorded");
  if (consecutiveFailures >= MAX_FAILURES && circuitOpenSince === null) {
    circuitOpenSince = Date.now();
    logger.error({ consecutiveFailures }, "Auth circuit breaker OPEN — blocking token reads");
  }
}

export function recordAuthSuccess(): void {
  if (consecutiveFailures > 0 || circuitOpenSince !== null) {
    logger.info("Auth circuit breaker reset on success");
  }
  consecutiveFailures = 0;
  circuitOpenSince = null;
}

export function checkCircuit(): { allowed: boolean; reason?: string } {
  if (circuitOpenSince === null) {
    return { allowed: true };
  }

  // Auto-reset after timeout
  const elapsed = Date.now() - circuitOpenSince;
  if (elapsed >= RESET_TIMEOUT_MS) {
    logger.info({ elapsedMs: elapsed }, "Auth circuit breaker auto-reset after timeout");
    consecutiveFailures = 0;
    circuitOpenSince = null;
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Auth circuit breaker open: ${consecutiveFailures} consecutive failures. Resets in ${Math.ceil((RESET_TIMEOUT_MS - elapsed) / 60000)} minutes.`,
  };
}

export function resetCircuit(): void {
  consecutiveFailures = 0;
  circuitOpenSince = null;
  logger.info("Auth circuit breaker manually reset");
}
