import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../config.js', () => ({
  ONECLI_URL: 'http://localhost:10254',
  CALENDAR_POLL_INTERVAL: 300000,
  CALENDAR_LOOKAHEAD_MS: 86400000,
  CALENDAR_HOLD_BUFFER_MS: 300000,
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import { storeCalendarEvents } from '../calendar-poller.js';
import {
  insertTrackedItem,
  upsertThread,
  type TrackedItem,
} from '../tracked-items.js';
import {
  correlateByAttendee,
  correlateBySubject,
  getThreadLinks,
  getItemThreadLinks,
} from '../thread-correlator.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

function makeItem(overrides: Partial<TrackedItem>): TrackedItem {
  return {
    id: 'item_1',
    source: 'gmail',
    source_id: 'gmail:thread_abc',
    group_name: 'main',
    state: 'detected',
    classification: null,
    superpilot_label: null,
    trust_tier: null,
    title: 'RE: Project Update',
    summary: null,
    thread_id: 'thread_abc',
    detected_at: Date.now(),
    pushed_at: null,
    resolved_at: null,
    resolution_method: null,
    digest_count: 0,
    telegram_message_id: null,
    classification_reason: null,
    metadata: { sender: 'alice@company.com' },
    ...overrides,
  };
}

describe('correlateByAttendee', () => {
  it('links email item to calendar event when sender is attendee', () => {
    const now = Date.now();
    storeCalendarEvents([
      {
        id: 'evt-1',
        title: 'Team Meeting',
        start_time: now + 3600000,
        end_time: now + 7200000,
        attendees: ['alice@company.com', 'bob@company.com'],
        location: null,
        source_account: null,
      },
    ]);

    const item = makeItem({ metadata: { sender: 'alice@company.com' } });
    insertTrackedItem(item);

    const links = correlateByAttendee(item);

    expect(links).toHaveLength(1);
    expect(links[0].thread_id).toBe('cal:evt-1');
    expect(links[0].item_id).toBe('item_1');
    expect(links[0].link_type).toBe('attendee_match');
    expect(links[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('returns empty when sender is not an attendee', () => {
    const now = Date.now();
    storeCalendarEvents([
      {
        id: 'evt-2',
        title: 'Other Meeting',
        start_time: now + 3600000,
        end_time: now + 7200000,
        attendees: ['charlie@company.com'],
        location: null,
        source_account: null,
      },
    ]);

    const item = makeItem({ metadata: { sender: 'alice@company.com' } });
    insertTrackedItem(item);

    const links = correlateByAttendee(item);
    expect(links).toHaveLength(0);
  });

  it('matches case-insensitively', () => {
    const now = Date.now();
    storeCalendarEvents([
      {
        id: 'evt-3',
        title: 'Case Test Meeting',
        start_time: now + 3600000,
        end_time: now + 7200000,
        attendees: ['Alice@Company.COM'],
        location: null,
        source_account: null,
      },
    ]);

    const item = makeItem({ metadata: { sender: 'alice@company.com' } });
    insertTrackedItem(item);

    const links = correlateByAttendee(item);
    expect(links).toHaveLength(1);
    expect(links[0].thread_id).toBe('cal:evt-3');
  });

  it('returns empty when item has no sender', () => {
    const item = makeItem({ metadata: {} });
    insertTrackedItem(item);

    const links = correlateByAttendee(item);
    expect(links).toHaveLength(0);
  });
});

describe('correlateBySubject', () => {
  it('links items with similar titles to same thread (exact match after RE: strip)', () => {
    const thread = {
      id: 'thread_proj',
      group_name: 'main',
      title: 'Project Update',
      source_hint: null,
      created_at: Date.now() - 86400000,
      resolved_at: null,
      item_count: 1,
      state: 'active' as const,
    };
    upsertThread(thread);

    const item = makeItem({ title: 'RE: Project Update' });
    insertTrackedItem(item);

    const links = correlateBySubject(item, 'main');

    expect(links).toHaveLength(1);
    expect(links[0].thread_id).toBe('thread_proj');
    expect(links[0].link_type).toBe('subject_match');
    expect(links[0].confidence).toBeCloseTo(0.9);
  });

  it('strips RE:/FWD: prefixes for matching', () => {
    const thread = {
      id: 'thread_budget',
      group_name: 'main',
      title: 'Budget Review',
      source_hint: null,
      created_at: Date.now() - 86400000,
      resolved_at: null,
      item_count: 1,
      state: 'active' as const,
    };
    upsertThread(thread);

    const item = makeItem({ title: 'FWD: RE: Budget Review' });
    insertTrackedItem(item);

    const links = correlateBySubject(item, 'main');

    expect(links).toHaveLength(1);
    expect(links[0].thread_id).toBe('thread_budget');
  });

  it('returns empty when no matching thread exists', () => {
    const thread = {
      id: 'thread_other',
      group_name: 'main',
      title: 'Completely Different Topic',
      source_hint: null,
      created_at: Date.now() - 86400000,
      resolved_at: null,
      item_count: 1,
      state: 'active' as const,
    };
    upsertThread(thread);

    const item = makeItem({ title: 'Project Update' });
    insertTrackedItem(item);

    const links = correlateBySubject(item, 'main');
    expect(links).toHaveLength(0);
  });
});

describe('getThreadLinks', () => {
  it('returns stored links for a thread', () => {
    const now = Date.now();
    const db = getDb();
    db.prepare(
      `INSERT INTO thread_links (thread_id, item_id, link_type, confidence, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('cal:evt-x', 'item_abc', 'attendee_match', 0.85, now);

    const links = getThreadLinks('cal:evt-x');
    expect(links).toHaveLength(1);
    expect(links[0].thread_id).toBe('cal:evt-x');
    expect(links[0].item_id).toBe('item_abc');
    expect(links[0].link_type).toBe('attendee_match');
    expect(links[0].confidence).toBeCloseTo(0.85);
  });

  it('returns empty for unknown thread', () => {
    const links = getThreadLinks('nonexistent');
    expect(links).toHaveLength(0);
  });
});

describe('getItemThreadLinks', () => {
  it('returns all thread links for an item', () => {
    const now = Date.now();
    const db = getDb();
    db.prepare(
      `INSERT INTO thread_links (thread_id, item_id, link_type, confidence, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('cal:evt-y', 'item_xyz', 'subject_match', 0.7, now);
    db.prepare(
      `INSERT INTO thread_links (thread_id, item_id, link_type, confidence, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('thread_other', 'item_xyz', 'attendee_match', 0.85, now);

    const links = getItemThreadLinks('item_xyz');
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.thread_id)).toContain('cal:evt-y');
    expect(links.map((l) => l.thread_id)).toContain('thread_other');
  });

  it('returns empty for unknown item', () => {
    const links = getItemThreadLinks('nonexistent');
    expect(links).toHaveLength(0);
  });
});
