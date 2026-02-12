/**
 * rate-limiter.ts — Per-user rate limiting for complaint messages.
 *
 * Enforces daily message limits and burst detection (spam cooldown).
 * Self-contained module: only depends on better-sqlite3 Database type.
 */
import type Database from 'better-sqlite3';
import { getUserLanguage } from './db.js';
import { nowISO } from './utils.js';

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

interface RateLimitConfig {
  daily_msg_limit: number;
}

interface RateLimitRow {
  phone: string;
  date: string;
  message_count: number;
  last_message_at: string | null;
  recent_timestamps: string | null;
}

// --- Multilingual messages ---

const DAILY_LIMIT_MESSAGES: Record<string, string> = {
  mr: 'तुम्ही आजच्या संदेश मर्यादा गाठली आहे. कृपया उद्या पुन्हा प्रयत्न करा.',
  hi: 'आपने आज की संदेश सीमा पूरी कर ली है। कृपया कल फिर से प्रयास करें।',
  en: "You've reached your daily message limit. Please try again tomorrow.",
};

const BURST_COOLDOWN_MESSAGES: Record<string, string> = {
  mr: 'कृपया थांबा — खूप वेगाने संदेश पाठवत आहात. कृपया एक मिनिट प्रतीक्षा करा.',
  hi: 'कृपया रुकें — बहुत तेज़ी से संदेश भेज रहे हैं। कृपया एक मिनट प्रतीक्षा करें।',
  en: "You're sending messages too fast. Please wait for a 60-second cooldown.",
};

/** Burst threshold: 5 messages within this window triggers cooldown. */
const BURST_WINDOW_MS = 60_000;
const BURST_MAX_MESSAGES = 5;

/**
 * Check whether a user is allowed to send a message.
 *
 * Algorithm:
 * 1. Get or create rate_limits row for (phone, today)
 * 2. Check daily limit: message_count >= daily_msg_limit → deny
 * 3. Check burst: >=5 timestamps in last 60s → deny with cooldown
 * 4. If allowed: increment message_count, append timestamp, trim to 10
 */
export function checkRateLimit(
  db: Database.Database,
  phone: string,
  config: RateLimitConfig,
): RateLimitResult {
  const now = nowISO();
  const nowMs = Date.now();
  const today = now.slice(0, 10);

  // Look up user language (default to Marathi)
  const lang = getUserLanguage(db, phone) ?? 'mr';

  // Get or create today's rate limit row
  let row = db
    .prepare('SELECT * FROM rate_limits WHERE phone = ? AND date = ?')
    .get(phone, today) as RateLimitRow | undefined;

  if (!row) {
    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, last_message_at, recent_timestamps)
       VALUES (?, ?, 0, NULL, '[]')`,
    ).run(phone, today);
    row = db
      .prepare('SELECT * FROM rate_limits WHERE phone = ? AND date = ?')
      .get(phone, today) as RateLimitRow;
  }

  // 1. Check daily limit
  if (row.message_count >= config.daily_msg_limit) {
    return {
      allowed: false,
      reason: DAILY_LIMIT_MESSAGES[lang] || DAILY_LIMIT_MESSAGES.en,
    };
  }

  // 2. Check burst (5 messages within 60 seconds)
  let recentTimestamps: string[] = [];
  if (row.recent_timestamps) {
    try {
      recentTimestamps = JSON.parse(row.recent_timestamps);
    } catch (err) {
      console.warn(
        'Failed to parse recent_timestamps:',
        (err as Error).message,
      );
    }
  }

  const recentWithinWindow = recentTimestamps.filter((ts) => {
    const tsMs = new Date(ts).getTime();
    return nowMs - tsMs < BURST_WINDOW_MS;
  });

  if (recentWithinWindow.length >= BURST_MAX_MESSAGES) {
    // Calculate retry time: oldest timestamp in window + 60s
    const oldestInWindow = recentWithinWindow.reduce((oldest, ts) => {
      return new Date(ts).getTime() < new Date(oldest).getTime() ? ts : oldest;
    });
    const retryAfterMs = Math.max(
      0,
      new Date(oldestInWindow).getTime() + BURST_WINDOW_MS - nowMs,
    );

    return {
      allowed: false,
      reason: BURST_COOLDOWN_MESSAGES[lang] || BURST_COOLDOWN_MESSAGES.en,
      retryAfterMs,
    };
  }

  // 3. Allowed — update DB
  const updatedTimestamps = [...recentTimestamps, now].slice(-10);

  db.prepare(
    `UPDATE rate_limits
     SET message_count = message_count + 1,
         last_message_at = ?,
         recent_timestamps = ?
     WHERE phone = ? AND date = ?`,
  ).run(now, JSON.stringify(updatedTimestamps), phone, today);

  return { allowed: true };
}
