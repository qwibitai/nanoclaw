/**
 * In-memory sliding-window rate limiter.
 *
 * Tracks message timestamps per JID for the last WINDOW_MS milliseconds.
 * No DB — purely in-memory, resets on nanoclaw restart (acceptable for abuse
 * prevention; a restart clears burst state, which is fine for this use case).
 */

const WINDOW_MS = 60_000; // 1 minute sliding window
const MAX_MESSAGES = 10; // max user messages per JID per window

/** Map<jid, timestamp[]> — timestamps of user messages within the window */
const windows = new Map<string, number[]>();

/**
 * Records `count` new messages from `jid` and returns true if the JID has
 * exceeded the rate limit.
 *
 * Call AFTER confirming the messages are real user messages (not bot/from_me).
 * `count` lets callers record a batch of messages in one call.
 */
export function isRateLimited(jid: string, count: number = 1): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  // Evict timestamps outside the sliding window
  const prev = (windows.get(jid) ?? []).filter((ts) => ts > cutoff);

  // Record `count` new message timestamps
  const next = [...prev, ...Array<number>(count).fill(now)];
  windows.set(jid, next);

  return next.length > MAX_MESSAGES;
}

/** Clear the rate-limit state for a JID (e.g. after an operator reset). */
export function clearRateLimit(jid: string): void {
  windows.delete(jid);
}
