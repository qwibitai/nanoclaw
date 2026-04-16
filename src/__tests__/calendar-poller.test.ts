import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';

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
vi.mock('../calendar-fetcher.js', () => ({
  discoverCalendarAccounts: vi.fn(() => []),
  fetchCalendarEvents: vi.fn(async () => []),
}));

import {
  storeCalendarEvents,
  getUpcomingEvents,
  getEventsInRange,
  pollCalendar,
  cleanupOldEvents,
  type CalendarEvent,
} from '../calendar-poller.js';
import { eventBus } from '../event-bus.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    title: 'Team Standup',
    start_time: 1700000000000,
    end_time: 1700003600000,
    attendees: ['alice@example.com'],
    location: 'Zoom',
    source_account: 'work@example.com',
    ...overrides,
  };
}

describe('storeCalendarEvents', () => {
  it('stores a single event and retrieves it via getUpcomingEvents', () => {
    const event = makeEvent();
    storeCalendarEvents([event]);

    const results = getUpcomingEvents(
      event.start_time - 1000,
      event.end_time - event.start_time + 10000,
    );
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('evt-1');
    expect(results[0].title).toBe('Team Standup');
    expect(results[0].attendees).toEqual(['alice@example.com']);
    expect(results[0].location).toBe('Zoom');
    expect(results[0].source_account).toBe('work@example.com');
  });

  it('handles empty array without error', () => {
    expect(() => storeCalendarEvents([])).not.toThrow();
  });

  it('upserts on same id (updates existing event)', () => {
    const original = makeEvent({ title: 'Original Title' });
    storeCalendarEvents([original]);

    const updated = makeEvent({
      title: 'Updated Title',
      end_time: 1700007200000,
    });
    storeCalendarEvents([updated]);

    const results = getUpcomingEvents(original.start_time - 1000, 10000000000);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Updated Title');
    expect(results[0].end_time).toBe(1700007200000);
  });

  it('stores multiple events in a single call', () => {
    const events = [
      makeEvent({
        id: 'evt-a',
        title: 'Event A',
        start_time: 1700000000000,
        end_time: 1700003600000,
      }),
      makeEvent({
        id: 'evt-b',
        title: 'Event B',
        start_time: 1700010000000,
        end_time: 1700013600000,
      }),
    ];
    storeCalendarEvents(events);

    const results = getUpcomingEvents(1700000000000 - 1, 20000000000);
    expect(results).toHaveLength(2);
  });

  it('stores events with null location and source_account', () => {
    const event = makeEvent({ location: null, source_account: null });
    storeCalendarEvents([event]);
    const results = getUpcomingEvents(event.start_time - 1, 10000000000);
    expect(results).toHaveLength(1);
    expect(results[0].location).toBeNull();
    expect(results[0].source_account).toBeNull();
  });
});

describe('getUpcomingEvents', () => {
  it('returns events where end_time > now and start_time <= now + lookahead', () => {
    const now = 1700000000000;
    const lookahead = 3600000; // 1 hour

    // Should be included: starts within lookahead window
    const inWindow = makeEvent({
      id: 'in-window',
      start_time: now + 1800000, // 30 min from now
      end_time: now + 5400000, // 90 min from now
    });

    // Should be excluded: starts after lookahead
    const outOfWindow = makeEvent({
      id: 'out-of-window',
      start_time: now + 7200000, // 2 hours from now
      end_time: now + 10800000,
    });

    // Should be included: currently active (started before now, ends after now)
    const active = makeEvent({
      id: 'active',
      start_time: now - 1800000, // started 30 min ago
      end_time: now + 1800000, // ends 30 min from now
    });

    // Should be excluded: already ended
    const ended = makeEvent({
      id: 'ended',
      start_time: now - 7200000,
      end_time: now - 3600000, // ended 1 hour ago
    });

    storeCalendarEvents([inWindow, outOfWindow, active, ended]);

    const results = getUpcomingEvents(now, lookahead);
    const ids = results.map((e) => e.id);
    expect(ids).toContain('in-window');
    expect(ids).toContain('active');
    expect(ids).not.toContain('out-of-window');
    expect(ids).not.toContain('ended');
  });

  it('returns empty array when no events exist', () => {
    const results = getUpcomingEvents(Date.now(), 3600000);
    expect(results).toEqual([]);
  });
});

describe('getEventsInRange', () => {
  it('returns events overlapping the given range', () => {
    const rangeStart = 1700010000000;
    const rangeEnd = 1700020000000;

    // Fully inside range
    const inside = makeEvent({
      id: 'inside',
      start_time: rangeStart + 1000000,
      end_time: rangeStart + 2000000,
    });

    // Starts before range, ends inside
    const overlapsStart = makeEvent({
      id: 'overlaps-start',
      start_time: rangeStart - 1000000,
      end_time: rangeStart + 1000000,
    });

    // Starts inside range, ends after
    const overlapsEnd = makeEvent({
      id: 'overlaps-end',
      start_time: rangeEnd - 1000000,
      end_time: rangeEnd + 1000000,
    });

    // Spans entire range
    const spans = makeEvent({
      id: 'spans',
      start_time: rangeStart - 1000000,
      end_time: rangeEnd + 1000000,
    });

    // Before range entirely
    const before = makeEvent({
      id: 'before',
      start_time: rangeStart - 5000000,
      end_time: rangeStart - 1000,
    });

    // After range entirely
    const after = makeEvent({
      id: 'after',
      start_time: rangeEnd + 1000,
      end_time: rangeEnd + 5000000,
    });

    storeCalendarEvents([
      inside,
      overlapsStart,
      overlapsEnd,
      spans,
      before,
      after,
    ]);

    const results = getEventsInRange(rangeStart, rangeEnd);
    const ids = results.map((e) => e.id);

    expect(ids).toContain('inside');
    expect(ids).toContain('overlaps-start');
    expect(ids).toContain('overlaps-end');
    expect(ids).toContain('spans');
    expect(ids).not.toContain('before');
    expect(ids).not.toContain('after');
  });

  it('returns empty array when no events overlap', () => {
    const event = makeEvent({
      start_time: 1700000000000,
      end_time: 1700003600000,
    });
    storeCalendarEvents([event]);

    const results = getEventsInRange(1800000000000, 1800003600000);
    expect(results).toEqual([]);
  });
});

describe('pollCalendar', () => {
  it('stores events from a successful fetch and emits calendar.synced', async () => {
    const mockEvents = [
      {
        id: 'evt-poll-1',
        title: 'Standup',
        start: '2026-04-16T09:00:00Z',
        end: '2026-04-16T09:30:00Z',
        attendees: [{ email: 'alice@test.com' }],
        location: 'Zoom',
        source_account: 'work@test.com',
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: mockEvents }),
    }) as any;

    await pollCalendar();

    expect(vi.mocked(eventBus.emit)).toHaveBeenCalledWith(
      'calendar.synced',
      expect.objectContaining({
        type: 'calendar.synced',
        payload: expect.objectContaining({ eventsFound: 1 }),
      }),
    );

    // Verify event was stored
    const stored = getUpcomingEvents(0, Date.now() + 999999999999);
    expect(stored.some((e) => e.id === 'evt-poll-1')).toBe(true);
  });

  it('handles non-OK response gracefully without throwing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as any;

    await expect(pollCalendar()).resolves.toBeUndefined();
  });

  it('handles response with summary field instead of title', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        events: [
          {
            id: 'evt-summary',
            summary: 'Weekly Sync',
            start: { dateTime: '2026-04-16T10:00:00-07:00' },
            end: { dateTime: '2026-04-16T10:30:00-07:00' },
            attendees: ['bob@test.com'],
          },
        ],
      }),
    }) as any;

    await pollCalendar();

    const stored = getUpcomingEvents(0, Date.now() + 999999999999);
    const evt = stored.find((e) => e.id === 'evt-summary');
    expect(evt).toBeDefined();
    expect(evt!.title).toBe('Weekly Sync');
  });
});

describe('cleanupOldEvents', () => {
  it('removes events older than the cutoff', () => {
    const oldEvent: CalendarEvent = {
      id: 'old-evt',
      title: 'Old Meeting',
      start_time: 1000,
      end_time: 2000,
      attendees: [],
      location: null,
      source_account: null,
    };
    const recentEvent: CalendarEvent = {
      id: 'recent-evt',
      title: 'Recent Meeting',
      start_time: Date.now() - 1000,
      end_time: Date.now() + 3600000,
      attendees: [],
      location: null,
      source_account: null,
    };

    storeCalendarEvents([oldEvent, recentEvent]);
    cleanupOldEvents(86400000); // 1 day

    const remaining = getUpcomingEvents(0, Date.now() + 999999999999);
    expect(remaining.some((e) => e.id === 'old-evt')).toBe(false);
    expect(remaining.some((e) => e.id === 'recent-evt')).toBe(true);
  });
});
