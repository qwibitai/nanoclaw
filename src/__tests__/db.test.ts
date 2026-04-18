import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  TIMEZONE: 'America/Los_Angeles',
  DATA_DIR: '/tmp/nanoclaw-test',
  STORE_DIR: '/tmp/nanoclaw-test/store',
  ASSISTANT_NAME: 'Andy',
}));

import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';

// ---------------------------------------------------------------------------
// calendar_events table
// ---------------------------------------------------------------------------

describe('calendar_events table', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('inserts and retrieves a calendar event', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO calendar_events (id, title, start_time, end_time, attendees, location, source_account, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'evt-1',
      'Team Standup',
      1700000000,
      1700001800,
      '["alice@x.com","bob@x.com"]',
      'Zoom',
      'work@example.com',
      1700009999,
    );

    const row = db
      .prepare(`SELECT * FROM calendar_events WHERE id = ?`)
      .get('evt-1') as Record<string, unknown>;
    expect(row).not.toBeNull();
    expect(row['id']).toBe('evt-1');
    expect(row['title']).toBe('Team Standup');
    expect(row['start_time']).toBe(1700000000);
    expect(row['end_time']).toBe(1700001800);
    expect(row['attendees']).toBe('["alice@x.com","bob@x.com"]');
    expect(row['location']).toBe('Zoom');
    expect(row['source_account']).toBe('work@example.com');
    expect(row['fetched_at']).toBe(1700009999);
  });

  it('upserts on conflict by id (title and times update)', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO calendar_events (id, title, start_time, end_time, attendees, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('evt-2', 'Original Title', 1700000000, 1700001800, '[]', 1700009999);

    db.prepare(
      `INSERT INTO calendar_events (id, title, start_time, end_time, attendees, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, start_time = excluded.start_time, end_time = excluded.end_time`,
    ).run('evt-2', 'Updated Title', 1700005000, 1700006800, '[]', 1700009999);

    const row = db
      .prepare(`SELECT * FROM calendar_events WHERE id = ?`)
      .get('evt-2') as Record<string, unknown>;
    expect(row['title']).toBe('Updated Title');
    expect(row['start_time']).toBe(1700005000);
    expect(row['end_time']).toBe(1700006800);

    const count = (
      db.prepare(`SELECT COUNT(*) as c FROM calendar_events`).get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// thread_links table
// ---------------------------------------------------------------------------

describe('thread_links table', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('stores a thread link with all fields', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO thread_links (thread_id, item_id, link_type, confidence, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('thread-1', 'item-1', 'email', 0.95, 1700000000);

    const row = db
      .prepare(`SELECT * FROM thread_links WHERE thread_id = ? AND item_id = ?`)
      .get('thread-1', 'item-1') as Record<string, unknown>;
    expect(row).not.toBeNull();
    expect(row['thread_id']).toBe('thread-1');
    expect(row['item_id']).toBe('item-1');
    expect(row['link_type']).toBe('email');
    expect(row['confidence']).toBeCloseTo(0.95);
    expect(row['created_at']).toBe(1700000000);
  });

  it('enforces unique (thread_id, item_id) composite primary key', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO thread_links (thread_id, item_id, link_type, confidence, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('thread-1', 'item-1', 'email', 0.9, 1700000000);

    expect(() => {
      db.prepare(
        `INSERT INTO thread_links (thread_id, item_id, link_type, confidence, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('thread-1', 'item-1', 'calendar', 0.5, 1700000001);
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// delegation_counters table
// ---------------------------------------------------------------------------

describe('delegation_counters table', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('creates delegation_counters table with correct schema', () => {
    const db = getDb();
    const info = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'delegation_counters'",
      )
      .get() as { sql: string } | undefined;
    expect(info).toBeDefined();
    expect(info!.sql).toContain('group_name');
    expect(info!.sql).toContain('action_class');
    expect(info!.sql).toContain('count');
  });

  it('supports upsert on delegation_counters', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO delegation_counters (group_name, action_class, count, last_delegated_at)
       VALUES ('main', 'comms.write', 1, 1000)
       ON CONFLICT(group_name, action_class)
       DO UPDATE SET count = count + 1, last_delegated_at = 2000`,
    ).run();

    db.prepare(
      `INSERT INTO delegation_counters (group_name, action_class, count, last_delegated_at)
       VALUES ('main', 'comms.write', 1, 1000)
       ON CONFLICT(group_name, action_class)
       DO UPDATE SET count = count + 1, last_delegated_at = 2000`,
    ).run();

    const row = db
      .prepare(
        'SELECT count FROM delegation_counters WHERE group_name = ? AND action_class = ?',
      )
      .get('main', 'comms.write') as { count: number };
    expect(row.count).toBe(2);
  });
});
