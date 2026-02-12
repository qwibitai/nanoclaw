import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

import { checkRateLimit } from './rate-limiter.js';

let db: Database.Database;

/** Create rate_limits and users tables in an in-memory DB. */
function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
        phone TEXT NOT NULL,
        date TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        last_message_at TEXT,
        recent_timestamps TEXT,
        PRIMARY KEY (phone, date)
    );
    CREATE TABLE IF NOT EXISTS users (
        phone TEXT PRIMARY KEY,
        name TEXT,
        language TEXT DEFAULT 'mr',
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        total_complaints INTEGER DEFAULT 0,
        is_blocked INTEGER DEFAULT 0
    );
  `);
}

/** Insert a user with a given language. */
function insertUser(
  database: Database.Database,
  phone: string,
  language: string,
): void {
  database
    .prepare(
      `INSERT OR REPLACE INTO users (phone, language, first_seen, last_seen)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    )
    .run(phone, language);
}

beforeEach(() => {
  db = new Database(':memory:');
  createSchema(db);
});

// ============================================================
// Basic allow / deny
// ============================================================

describe('checkRateLimit', () => {
  it('allows the first message of the day', () => {
    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('allows the 20th message at default limit', () => {
    // Pre-seed 19 messages
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 19, '[]')`,
    ).run('919876543210', today);

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(true);
  });

  it('blocks the 21st message with daily limit reason', () => {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 20, '[]')`,
    ).run('919876543210', today);

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(false);
    // Default language is Marathi (no user record)
    expect(result.reason).toMatch(/मर्यादा|daily/);
  });

  it('resets on a new day', () => {
    // Seed yesterday at limit
    const yesterday = new Date(Date.now() - 86400000)
      .toISOString()
      .slice(0, 10);
    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 20, '[]')`,
    ).run('919876543210', yesterday);

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(true);
  });

  it('supports configurable daily limit (e.g., 10)', () => {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 10, '[]')`,
    ).run('919876543210', today);

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 10 });
    expect(result.allowed).toBe(false);
    // Default language is Marathi (no user record)
    expect(result.reason).toMatch(/मर्यादा|daily/);
  });

  it('rate-limits users independently', () => {
    const today = new Date().toISOString().slice(0, 10);
    // User A at limit
    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 20, '[]')`,
    ).run('919876543210', today);

    // User B should still be allowed
    const resultA = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    const resultB = checkRateLimit(db, '919999999999', { daily_msg_limit: 20 });

    expect(resultA.allowed).toBe(false);
    expect(resultB.allowed).toBe(true);
  });
});

// ============================================================
// Burst detection
// ============================================================

describe('burst detection', () => {
  it('allows 4 messages within 60 seconds', () => {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const timestamps = Array.from({ length: 4 }, (_, i) =>
      new Date(now - (4 - i) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );

    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 4, ?)`,
    ).run('919876543210', today, JSON.stringify(timestamps));

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(true);
  });

  it('blocks 5th message within 60 seconds (spam cooldown)', () => {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    // 5 timestamps all within last 30 seconds
    const timestamps = Array.from({ length: 5 }, (_, i) =>
      new Date(now - (5 - i) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );

    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 5, ?)`,
    ).run('919876543210', today, JSON.stringify(timestamps));

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(false);
    // Default language is Marathi (no user record)
    expect(result.reason).toMatch(/थांबा|cooldown/);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60000);
  });

  it('allows messages after 60-second cooldown expires', () => {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    // 5 timestamps all older than 60 seconds
    const timestamps = Array.from({ length: 5 }, (_, i) =>
      new Date(now - 70000 - (5 - i) * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, 'Z'),
    );

    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 5, ?)`,
    ).run('919876543210', today, JSON.stringify(timestamps));

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(true);
  });
});

// ============================================================
// Multilingual messages
// ============================================================

describe('multilingual denial messages', () => {
  it('returns Marathi message for Marathi users (daily limit)', () => {
    insertUser(db, '919876543210', 'mr');
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 20, '[]')`,
    ).run('919876543210', today);

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(false);
    // Marathi message check
    expect(result.reason).toMatch(/मर्यादा|उद्या/);
  });

  it('returns Hindi message for Hindi users (daily limit)', () => {
    insertUser(db, '919876543210', 'hi');
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 20, '[]')`,
    ).run('919876543210', today);

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/सीमा|कल/);
  });

  it('returns English message for English users (daily limit)', () => {
    insertUser(db, '919876543210', 'en');
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 20, '[]')`,
    ).run('919876543210', today);

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('daily message limit');
  });

  it('defaults to Marathi for unknown users', () => {
    // No user inserted — should default to 'mr'
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 20, '[]')`,
    ).run('919876543210', today);

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/मर्यादा|उद्या/);
  });

  it('returns Marathi burst cooldown message for Marathi users', () => {
    insertUser(db, '919876543210', 'mr');
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const timestamps = Array.from({ length: 5 }, (_, i) =>
      new Date(now - (5 - i) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );

    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 5, ?)`,
    ).run('919876543210', today, JSON.stringify(timestamps));

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/थांबा|प्रतीक्षा/);
  });

  it('returns English burst cooldown message for English users', () => {
    insertUser(db, '919876543210', 'en');
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const timestamps = Array.from({ length: 5 }, (_, i) =>
      new Date(now - (5 - i) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    );

    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 5, ?)`,
    ).run('919876543210', today, JSON.stringify(timestamps));

    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cooldown');
  });
});

// ============================================================
// DB state management
// ============================================================

describe('DB state tracking', () => {
  it('increments message_count on each allowed message', () => {
    checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });

    const today = new Date().toISOString().slice(0, 10);
    const row = db
      .prepare(
        'SELECT message_count FROM rate_limits WHERE phone = ? AND date = ?',
      )
      .get('919876543210', today) as { message_count: number };
    expect(row.message_count).toBe(3);
  });

  it('trims recent_timestamps to last 10 entries', () => {
    // Send 12 messages (all allowed since limit is 20)
    for (let i = 0; i < 12; i++) {
      checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    }

    const today = new Date().toISOString().slice(0, 10);
    const row = db
      .prepare(
        'SELECT recent_timestamps FROM rate_limits WHERE phone = ? AND date = ?',
      )
      .get('919876543210', today) as { recent_timestamps: string };
    const timestamps = JSON.parse(row.recent_timestamps) as string[];
    expect(timestamps.length).toBeLessThanOrEqual(10);
  });

  it('does not increment message_count when blocked', () => {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 20, '[]')`,
    ).run('919876543210', today);

    checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });

    const row = db
      .prepare(
        'SELECT message_count FROM rate_limits WHERE phone = ? AND date = ?',
      )
      .get('919876543210', today) as { message_count: number };
    expect(row.message_count).toBe(20); // unchanged
  });
});

// ============================================================
// JSON parse safety
// ============================================================

describe('malformed recent_timestamps JSON', () => {
  it('treats malformed JSON as empty array and allows message', () => {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO rate_limits (phone, date, message_count, recent_timestamps)
       VALUES (?, ?, 2, 'not-valid-json')`,
    ).run('919876543210', today);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = checkRateLimit(db, '919876543210', { daily_msg_limit: 20 });
    expect(result.allowed).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
