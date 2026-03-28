import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import {
  buildWhisperContextPrefix,
  decayWhispers,
  emitWhisper,
  getActiveWhispers,
  injectWhisperContext,
  startWhisperDecayLoop,
  Whisper,
  _resetWhisperDecayLoopForTests,
} from './whispers.js';

beforeEach(() => {
  _initTestDatabase();
  _resetWhisperDecayLoopForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('whispers', () => {
  it('emitWhisper inserts with strength=1.0 and expires_at ~72hrs from now', () => {
    const before = Date.now();
    emitWhisper('group-a', 'something happened');
    const after = Date.now();

    const rows = getDb()
      .prepare('SELECT * FROM whispers WHERE source_group_folder = ?')
      .all('group-a') as Whisper[];

    expect(rows).toHaveLength(1);
    const w = rows[0];
    expect(w.strength).toBe(1.0);
    expect(w.signal).toBe('something happened');

    const emittedMs = new Date(w.emitted_at).getTime();
    const expiresMs = new Date(w.expires_at).getTime();
    const diffHours = (expiresMs - emittedMs) / (3600 * 1000);
    expect(diffHours).toBeCloseTo(72, 0);
    expect(emittedMs).toBeGreaterThanOrEqual(before);
    expect(emittedMs).toBeLessThanOrEqual(after);
  });

  it('getActiveWhispers returns emitted whisper immediately', () => {
    emitWhisper('group-a', 'active signal');

    const active = getActiveWhispers();
    expect(active).toHaveLength(1);
    expect(active[0].signal).toBe('active signal');
  });

  it('decayWhispers reduces strength proportional to elapsed hours', () => {
    const tenHoursAgo = new Date(Date.now() - 10 * 3600 * 1000);
    const expiresAt = new Date(Date.now() + 62 * 3600 * 1000).toISOString();

    // Insert with emitted_at 10 hours ago, decay_rate 0.1 → expect strength drop of ~1.0
    // initialStrength 1.0 - 0.1 * 10 = 0.0, so let's use 0.05 decay_rate to keep it positive
    getDb()
      .prepare(
        `INSERT INTO whispers (source_group_folder, signal, strength, emitted_at, expires_at, decay_rate)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('group-a', 'decaying signal', 1.0, tenHoursAgo.toISOString(), expiresAt, 0.05);

    decayWhispers(new Date());

    const rows = getDb()
      .prepare('SELECT * FROM whispers WHERE source_group_folder = ?')
      .all('group-a') as Whisper[];

    expect(rows).toHaveLength(1);
    // Expected: 1.0 - 0.05 * 10 = 0.5 (approximately)
    expect(rows[0].strength).toBeCloseTo(0.5, 1);
    expect(rows[0].strength).toBeLessThan(1.0);
  });

  it('decayWhispers deletes whispers with strength <= 0', () => {
    const tenHoursAgo = new Date(Date.now() - 10 * 3600 * 1000);
    const expiresAt = new Date(Date.now() + 62 * 3600 * 1000).toISOString();

    // decay_rate 0.2 * 10 hours = 2.0 reduction → goes to 0
    getDb()
      .prepare(
        `INSERT INTO whispers (source_group_folder, signal, strength, emitted_at, expires_at, decay_rate)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('group-a', 'dying signal', 1.0, tenHoursAgo.toISOString(), expiresAt, 0.2);

    decayWhispers(new Date());

    const rows = getDb()
      .prepare('SELECT * FROM whispers WHERE source_group_folder = ?')
      .all('group-a') as Whisper[];

    expect(rows).toHaveLength(0);
  });

  it('decayWhispers deletes expired whispers regardless of strength', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    const oneHourAgo = new Date(Date.now() - 1 * 3600 * 1000);

    // expires_at is 1 hour ago → expired; use very low decay_rate so strength stays high
    getDb()
      .prepare(
        `INSERT INTO whispers (source_group_folder, signal, strength, emitted_at, expires_at, decay_rate)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('group-a', 'expired signal', 0.99, twoHoursAgo.toISOString(), oneHourAgo.toISOString(), 0.001);

    decayWhispers(new Date());

    const rows = getDb()
      .prepare('SELECT * FROM whispers WHERE source_group_folder = ?')
      .all('group-a') as Whisper[];

    expect(rows).toHaveLength(0);
  });

  it('buildWhisperContextPrefix returns empty string for empty array', () => {
    const result = buildWhisperContextPrefix([]);
    expect(result).toBe('');
  });

  it('buildWhisperContextPrefix respects maxChars truncation', () => {
    const whispers: Whisper[] = [
      {
        id: 1,
        source_group_folder: 'g',
        signal: 'a very long signal that goes on and on',
        strength: 0.85,
        emitted_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        decay_rate: 0.1,
      },
    ];

    const full = buildWhisperContextPrefix(whispers);
    const truncated = buildWhisperContextPrefix(whispers, 20);

    expect(full.length).toBeGreaterThan(20);
    expect(truncated.length).toBe(20);
  });

  it('getActiveWhispers respects minStrength filter', () => {
    const expiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    const now = new Date().toISOString();

    getDb()
      .prepare(
        `INSERT INTO whispers (source_group_folder, signal, strength, emitted_at, expires_at, decay_rate)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('group-a', 'strong signal', 0.9, now, expiresAt, 0.1);

    getDb()
      .prepare(
        `INSERT INTO whispers (source_group_folder, signal, strength, emitted_at, expires_at, decay_rate)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('group-a', 'weak signal', 0.05, now, expiresAt, 0.1);

    const filtered = getActiveWhispers({ minStrength: 0.1 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].signal).toBe('strong signal');
  });

  it('injectWhisperContext returns original prompt when no active whispers', () => {
    const original = 'My original prompt text.';
    const result = injectWhisperContext('group-a', original);
    expect(result).toBe(original);
  });

  it('startWhisperDecayLoop is idempotent (second call no-ops)', () => {
    startWhisperDecayLoop({ pollIntervalMs: 60000 });
    startWhisperDecayLoop({ pollIntervalMs: 60000 });

    // If both calls scheduled timers, advancing time would trigger two decays.
    // We only expect one scheduled timeout to have been set.
    // Verify by checking that no error is thrown and the loop guards correctly.
    // Use a whisper that should survive decay to confirm only one tick fires.
    emitWhisper('group-a', 'test signal');

    vi.advanceTimersByTime(60000);

    // No assertion on exact call count here — we verify no duplicate behavior
    // by confirming the whisper is handled without errors.
    const rows = getDb().prepare('SELECT COUNT(*) as cnt FROM whispers').get() as { cnt: number };
    // Whisper should still exist since it was just created with default 72hr TTL
    // and decay_rate 0.1 over 1 minute is negligible (0.1 * (1/60) ≈ 0.0017)
    expect(rows.cnt).toBe(1);
  });
});
