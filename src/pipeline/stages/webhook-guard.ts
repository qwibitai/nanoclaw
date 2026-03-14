/**
 * Shared webhook IP rate limiter.
 * Replaces the identical isRateLimited() + rateLimitMap pattern in quo.ts and messenger.ts.
 */
import { RATE_LIMITS } from '../../filters.js';
import { logger } from '../../logger.js';

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const windowMs = 60_000; // 1 minute
const maxRequests = RATE_LIMITS.webhookPerIp.perMinute;
const rateLimitMap = new Map<string, RateLimitEntry>();

// Clean stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > windowMs * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 300_000);

/** Returns true if the IP should be blocked. */
export function isWebhookRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > windowMs) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  if (entry.count > maxRequests) {
    logger.warn({ ip, count: entry.count }, 'Webhook IP rate limited');
    return true;
  }

  return false;
}
