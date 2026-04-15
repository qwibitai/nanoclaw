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

import { storeCalendarEvents } from '../calendar-poller.js';
import {
  findCalendarGaps,
  isInMeeting,
  scoreUrgency,
  suggestDeliveryTime,
  getNextMeetingIn,
} from '../scheduling-advisor.js';

// Fixed base time for deterministic tests: 2024-04-15T12:00:00.000Z
const baseTime = 1713200000000;
const ONE_HOUR = 3600000;
const FIVE_MIN = 300000;

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

describe('findCalendarGaps', () => {
  it('returns gap between two meetings', () => {
    const rangeStart = baseTime;
    const rangeEnd = baseTime + 4 * ONE_HOUR;

    // Meeting 1: baseTime to baseTime+1h
    // Gap: baseTime+1h to baseTime+2h
    // Meeting 2: baseTime+2h to baseTime+3h
    storeCalendarEvents([
      {
        id: 'mtg-1',
        title: 'Meeting 1',
        start_time: rangeStart,
        end_time: rangeStart + ONE_HOUR,
        attendees: [],
        location: null,
        source_account: null,
      },
      {
        id: 'mtg-2',
        title: 'Meeting 2',
        start_time: rangeStart + 2 * ONE_HOUR,
        end_time: rangeStart + 3 * ONE_HOUR,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);

    const gaps = findCalendarGaps(rangeStart, rangeEnd);
    expect(gaps.length).toBeGreaterThanOrEqual(1);

    const gapBetween = gaps.find(
      (g) =>
        g.start === rangeStart + ONE_HOUR &&
        g.end === rangeStart + 2 * ONE_HOUR,
    );
    expect(gapBetween).toBeDefined();
    expect(gapBetween!.durationMs).toBe(ONE_HOUR);
  });

  it('returns full range as one gap when no events', () => {
    const rangeStart = baseTime;
    const rangeEnd = baseTime + 4 * ONE_HOUR;

    const gaps = findCalendarGaps(rangeStart, rangeEnd);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].start).toBe(rangeStart);
    expect(gaps[0].end).toBe(rangeEnd);
    expect(gaps[0].durationMs).toBe(4 * ONE_HOUR);
  });

  it('returns no gaps when back-to-back meetings fill the range', () => {
    const rangeStart = baseTime;
    const rangeEnd = baseTime + 2 * ONE_HOUR;

    storeCalendarEvents([
      {
        id: 'mtg-a',
        title: 'Meeting A',
        start_time: rangeStart,
        end_time: rangeStart + ONE_HOUR,
        attendees: [],
        location: null,
        source_account: null,
      },
      {
        id: 'mtg-b',
        title: 'Meeting B',
        start_time: rangeStart + ONE_HOUR,
        end_time: rangeStart + 2 * ONE_HOUR,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);

    const gaps = findCalendarGaps(rangeStart, rangeEnd);
    expect(gaps).toHaveLength(0);
  });
});

describe('isInMeeting', () => {
  it('returns true when current time falls within an event', () => {
    // Event covers baseTime to baseTime+1h
    storeCalendarEvents([
      {
        id: 'active-mtg',
        title: 'Active Meeting',
        start_time: baseTime - FIVE_MIN,
        end_time: baseTime + ONE_HOUR,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);

    expect(isInMeeting(baseTime)).toBe(true);
  });

  it('returns false when no event covers current time', () => {
    // Event is in the future
    storeCalendarEvents([
      {
        id: 'future-mtg',
        title: 'Future Meeting',
        start_time: baseTime + ONE_HOUR,
        end_time: baseTime + 2 * ONE_HOUR,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);

    expect(isInMeeting(baseTime)).toBe(false);
  });
});

describe('scoreUrgency', () => {
  it('scores escalate tier as highest urgency (>= 0.8)', () => {
    const score = scoreUrgency({
      trustTier: 'escalate',
      ageMs: 0,
      digestCount: 0,
      classification: 'push',
    });
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  it('increases score with age', () => {
    const scoreNew = scoreUrgency({
      trustTier: 'propose',
      ageMs: 0,
      digestCount: 0,
      classification: 'push',
    });
    const scoreOld = scoreUrgency({
      trustTier: 'propose',
      ageMs: 4 * ONE_HOUR, // 4 hours old
      digestCount: 0,
      classification: 'push',
    });
    expect(scoreOld).toBeGreaterThan(scoreNew);
  });

  it('scores digest items lower than push', () => {
    const pushScore = scoreUrgency({
      trustTier: 'propose',
      ageMs: 0,
      digestCount: 0,
      classification: 'push',
    });
    const digestScore = scoreUrgency({
      trustTier: 'propose',
      ageMs: 0,
      digestCount: 0,
      classification: 'digest',
    });
    expect(digestScore).toBeLessThan(pushScore);
  });
});

describe('suggestDeliveryTime', () => {
  it('suggests immediate delivery when not in meeting and gap available', () => {
    // No meetings — user is free
    const result = suggestDeliveryTime(baseTime, 0.5);
    expect(result.action).toBe('deliver_now');
    expect(result.deliverAt).toBe(baseTime);
  });

  it('suggests delay when in meeting (deliverAt > now)', () => {
    // Active meeting from baseTime-5min to baseTime+1h
    // Gap starts at baseTime+1h
    storeCalendarEvents([
      {
        id: 'blocking-mtg',
        title: 'Blocking Meeting',
        start_time: baseTime - FIVE_MIN,
        end_time: baseTime + ONE_HOUR,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);

    const result = suggestDeliveryTime(baseTime, 0.5);
    expect(result.action).toBe('delay');
    expect(result.deliverAt).toBeGreaterThan(baseTime);
  });

  it('delivers immediately during meeting for high urgency (>= 0.95)', () => {
    // Active meeting
    storeCalendarEvents([
      {
        id: 'urgent-block',
        title: 'Meeting',
        start_time: baseTime - FIVE_MIN,
        end_time: baseTime + ONE_HOUR,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);

    const result = suggestDeliveryTime(baseTime, 0.95);
    expect(result.action).toBe('deliver_now');
    expect(result.deliverAt).toBe(baseTime);
  });
});

describe('getNextMeetingIn', () => {
  it('returns ms until next meeting when one exists in lookahead', () => {
    const nextMeetingStart = baseTime + 30 * 60 * 1000; // 30 min from now
    storeCalendarEvents([
      {
        id: 'next-mtg',
        title: 'Next Meeting',
        start_time: nextMeetingStart,
        end_time: nextMeetingStart + ONE_HOUR,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);

    const result = getNextMeetingIn(baseTime, 2 * ONE_HOUR);
    expect(result).toBe(30 * 60 * 1000);
  });

  it('returns null when no upcoming meetings in lookahead', () => {
    const result = getNextMeetingIn(baseTime, ONE_HOUR);
    expect(result).toBeNull();
  });
});
