/**
 * Tool Guardrails: rate limiting, spend tracking, and staleness checks.
 *
 * Pure functions for testing. Container-side uses inline copies
 * (container can't import from src/).
 */

// ── Rate Limiter ─────────────────────────────────────────────────────

export interface RateLimiterState {
  count: number;
  windowStart: number;
}

/**
 * Check if a tool call is within its rate limit.
 * Returns { allowed, remaining, resetsIn } for the caller to act on.
 */
export function checkRateLimit(
  state: RateLimiterState | undefined,
  maxPerWindow: number,
  windowMs: number,
  now: number = Date.now(),
): {
  allowed: boolean;
  remaining: number;
  resetsIn: number;
  newState: RateLimiterState;
} {
  if (!state || now - state.windowStart >= windowMs) {
    // New window
    return {
      allowed: true,
      remaining: maxPerWindow - 1,
      resetsIn: windowMs,
      newState: { count: 1, windowStart: now },
    };
  }

  if (state.count >= maxPerWindow) {
    return {
      allowed: false,
      remaining: 0,
      resetsIn: windowMs - (now - state.windowStart),
      newState: state,
    };
  }

  const newState = { count: state.count + 1, windowStart: state.windowStart };
  return {
    allowed: true,
    remaining: maxPerWindow - newState.count,
    resetsIn: windowMs - (now - state.windowStart),
    newState,
  };
}

// ── Spend Tracker ────────────────────────────────────────────────────

export interface SpendState {
  totalUsd: number;
  dayStart: number;
}

/**
 * Check if a spend amount is within the daily cap.
 * Returns { allowed, totalToday, remaining }.
 */
export function checkSpendLimit(
  state: SpendState | undefined,
  amountUsd: number,
  dailyCapUsd: number,
  now: number = Date.now(),
): {
  allowed: boolean;
  totalToday: number;
  remaining: number;
  newState: SpendState;
} {
  const dayMs = 86_400_000;

  if (!state || now - state.dayStart >= dayMs) {
    // New day
    return {
      allowed: amountUsd <= dailyCapUsd,
      totalToday: amountUsd,
      remaining: dailyCapUsd - amountUsd,
      newState: { totalUsd: amountUsd, dayStart: now },
    };
  }

  const projected = state.totalUsd + amountUsd;
  if (projected > dailyCapUsd) {
    return {
      allowed: false,
      totalToday: state.totalUsd,
      remaining: dailyCapUsd - state.totalUsd,
      newState: state,
    };
  }

  return {
    allowed: true,
    totalToday: projected,
    remaining: dailyCapUsd - projected,
    newState: { totalUsd: projected, dayStart: state.dayStart },
  };
}

// ── Default Limits ───────────────────────────────────────────────────

export const DEFAULT_RATE_LIMITS: Record<
  string,
  { max: number; windowMs: number }
> = {
  send_sms: { max: 10, windowMs: 3_600_000 }, // 10 per hour
  make_call: { max: 5, windowMs: 3_600_000 }, // 5 per hour
};

export const DEFAULT_DAILY_SPEND_CAP_USD = 10;
