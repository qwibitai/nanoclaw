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
 * Records message timestamps for `jid` and returns true if the JID has
 * exceeded the rate limit within the sliding window.
 *
 * Accepts actual message timestamps (epoch ms) instead of a synthetic count.
 * This prevents false-positives when processGroupMessages is called with a
 * historical backlog (e.g. startup recovery after a restart): messages sent
 * hours ago have timestamps outside the 60s window and are not counted.
 * Only messages genuinely sent within the last minute accumulate toward the cap.
 *
 * Call AFTER filtering to real user messages (not bot/from_me).
 */
export function isRateLimited(jid: string, messageTimestamps: number[]): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  // Evict timestamps outside the sliding window
  const prev = (windows.get(jid) ?? []).filter((ts) => ts > cutoff);

  // Only count messages whose own timestamp falls within the window.
  // Historical messages from backlogs (restart recovery, trigger accumulation)
  // are outside the window and correctly contribute 0 to the rate limit.
  const inWindow = messageTimestamps.filter((ts) => ts > cutoff);
  const next = [...prev, ...inWindow];
  windows.set(jid, next);

  return next.length > MAX_MESSAGES;
}

/** Clear the rate-limit state for a JID (e.g. after an operator reset). */
export function clearRateLimit(jid: string): void {
  windows.delete(jid);
}
