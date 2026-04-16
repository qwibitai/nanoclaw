import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../config.js', () => ({
  CALENDAR_LOOKAHEAD_MS: 86400000,
  CALENDAR_HOLD_BUFFER_MS: 300000,
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import { storeCalendarEvents, type CalendarEvent } from '../calendar-poller.js';
import {
  getMeetingBriefings,
  resetBriefingState,
  type BriefingRequest,
} from './meeting-briefing.js';

const NOW = 1700000000000;
const MINUTES_BEFORE = 30;

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    title: 'Team Standup',
    start_time: NOW + 25 * 60_000, // 25 minutes from now (within window)
    end_time: NOW + 55 * 60_000,
    attendees: ['alice@example.com', 'bob@example.com'],
    location: 'Zoom',
    source_account: 'work@example.com',
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
  resetBriefingState();
});

afterEach(() => {
  _closeDatabase();
});

describe('getMeetingBriefings', () => {
  it('generates a briefing for a meeting starting in 25 minutes (within 30-min window)', () => {
    storeCalendarEvents([makeEvent()]);

    const briefings = getMeetingBriefings(NOW, MINUTES_BEFORE);

    expect(briefings).toHaveLength(1);
    const b = briefings[0];
    expect(b.eventId).toBe('evt-1');
    expect(b.eventTitle).toBe('Team Standup');
    expect(b.startsAt).toBe(NOW + 25 * 60_000);
    expect(b.attendees).toEqual(['alice@example.com', 'bob@example.com']);
    expect(b.prompt).toContain('Team Standup');
    expect(b.prompt).toContain('alice@example.com');
    expect(b.prompt).toContain('bob@example.com');
    expect(b.prompt).toContain('Zoom');
    expect(b.prompt).toContain('3-5 bullets');
  });

  it('does NOT generate a briefing for a meeting more than 30 minutes away', () => {
    storeCalendarEvents([
      makeEvent({
        id: 'far-evt',
        start_time: NOW + 45 * 60_000, // 45 minutes from now — outside window
        end_time: NOW + 75 * 60_000,
      }),
    ]);

    const briefings = getMeetingBriefings(NOW, MINUTES_BEFORE);

    expect(briefings).toHaveLength(0);
  });

  it('does NOT generate a briefing for an already-started meeting', () => {
    storeCalendarEvents([
      makeEvent({
        id: 'started-evt',
        start_time: NOW - 5 * 60_000, // started 5 minutes ago
        end_time: NOW + 30 * 60_000,
      }),
    ]);

    const briefings = getMeetingBriefings(NOW, MINUTES_BEFORE);

    expect(briefings).toHaveLength(0);
  });

  it('does NOT generate a briefing for a meeting starting exactly at now (already started)', () => {
    storeCalendarEvents([
      makeEvent({
        id: 'now-evt',
        start_time: NOW, // starts exactly now — considered already started
        end_time: NOW + 60 * 60_000,
      }),
    ]);

    const briefings = getMeetingBriefings(NOW, MINUTES_BEFORE);

    expect(briefings).toHaveLength(0);
  });

  it('deduplicates — does not brief the same meeting twice', () => {
    storeCalendarEvents([makeEvent()]);

    const firstRun = getMeetingBriefings(NOW, MINUTES_BEFORE);
    expect(firstRun).toHaveLength(1);

    // Second call with same event still in window — should be deduped
    const secondRun = getMeetingBriefings(NOW, MINUTES_BEFORE);
    expect(secondRun).toHaveLength(0);
  });

  it('resets dedup state via resetBriefingState() — allows re-briefing after reset', () => {
    storeCalendarEvents([makeEvent()]);

    getMeetingBriefings(NOW, MINUTES_BEFORE);
    resetBriefingState();
    const briefings = getMeetingBriefings(NOW, MINUTES_BEFORE);

    expect(briefings).toHaveLength(1);
  });

  it('builds the prompt with the correct format', () => {
    storeCalendarEvents([
      makeEvent({
        title: 'Quarterly Review',
        attendees: ['ceo@company.com'],
        location: 'Conference Room A',
      }),
    ]);

    const briefings = getMeetingBriefings(NOW, MINUTES_BEFORE);
    expect(briefings).toHaveLength(1);

    const { prompt } = briefings[0];
    expect(prompt).toMatch(/Prepare a briefing for this meeting: Quarterly Review/);
    expect(prompt).toMatch(/Attendees: ceo@company\.com/);
    expect(prompt).toMatch(/Location: Conference Room A/);
    expect(prompt).toMatch(/Review recent emails, tracked items, and thread correlations/);
    expect(prompt).toMatch(/3-5 bullets/);
  });

  it('builds the prompt without location line when location is null', () => {
    storeCalendarEvents([
      makeEvent({ location: null }),
    ]);

    const briefings = getMeetingBriefings(NOW, MINUTES_BEFORE);
    expect(briefings).toHaveLength(1);
    expect(briefings[0].prompt).not.toContain('Location:');
  });

  it('handles events with no attendees gracefully', () => {
    storeCalendarEvents([
      makeEvent({ attendees: [] }),
    ]);

    const briefings = getMeetingBriefings(NOW, MINUTES_BEFORE);
    expect(briefings).toHaveLength(1);
    expect(briefings[0].prompt).toContain('None listed');
    expect(briefings[0].attendees).toEqual([]);
  });

  it('returns multiple briefings for multiple upcoming meetings', () => {
    storeCalendarEvents([
      makeEvent({ id: 'evt-a', title: 'Meeting A', start_time: NOW + 10 * 60_000, end_time: NOW + 40 * 60_000 }),
      makeEvent({ id: 'evt-b', title: 'Meeting B', start_time: NOW + 20 * 60_000, end_time: NOW + 50 * 60_000 }),
    ]);

    const briefings = getMeetingBriefings(NOW, MINUTES_BEFORE);
    expect(briefings).toHaveLength(2);
    const ids = briefings.map((b) => b.eventId);
    expect(ids).toContain('evt-a');
    expect(ids).toContain('evt-b');
  });
});
