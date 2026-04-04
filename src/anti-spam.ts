/**
 * Anti-spam: rate-limit error detection and per-JID notification cooldown.
 */

import { ERROR_COOLDOWN_MS, STALE_ENTRY_MS } from './constants.js';
const lastErrorNotifiedAt: Record<string, number> = {};

const RATE_LIMIT_PATTERNS = [
  'hit your limit',
  'rate limit',
  'rate_limit',
  'overloaded',
  '429',
];

export function isRateLimitError(text: string): boolean {
  const lower = text.toLowerCase();
  return RATE_LIMIT_PATTERNS.some((p) => lower.includes(p));
}

export function shouldNotifyError(chatJid: string): boolean {
  cleanupStaleEntries();
  const last = lastErrorNotifiedAt[chatJid];
  if (!last) return true;
  return Date.now() - last >= ERROR_COOLDOWN_MS;
}

/** Remove entries older than 7 days to prevent unbounded growth. */
function cleanupStaleEntries(): void {
  const now = Date.now();
  for (const key of Object.keys(lastErrorNotifiedAt)) {
    if (now - lastErrorNotifiedAt[key] > STALE_ENTRY_MS) {
      delete lastErrorNotifiedAt[key];
    }
  }
}

export function markErrorNotified(chatJid: string): void {
  lastErrorNotifiedAt[chatJid] = Date.now();
}

export function resetErrorCooldown(chatJid: string): void {
  delete lastErrorNotifiedAt[chatJid];
}
