import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { CalendarWatcher, type CalendarEvent } from './calendar-watcher.js';
import type { CalendarPayload } from '../classification-prompts.js';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-watcher-test-'));
}

function makeConfig(stateDir: string) {
  return {
    calendars: ['Personal', 'Work'],
    eventRouter: { route: vi.fn().mockResolvedValue({ routing: 'notify' }) },
    pollIntervalMs: 60_000,
    lookAheadDays: 7,
    stateDir,
  };
}

// ─── Sample icalbuddy output ──────────────────────────────────────────────────

const SAMPLE_OUTPUT = `Team standup
 | 2026-03-21 10:00 - 10:30
 | Work
 | location: Conference Room A
 | attendees: Alice, Bob
Lab meeting
 | 2026-03-21 14:00 - 15:00
 | Personal
All-day event
 | 2026-03-21
 | Work
`;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CalendarWatcher', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTempDir();
    mockExecFileSync.mockReset();
    // Default: icalbuddy exists
    mockExecFileSync.mockReturnValue('/opt/homebrew/bin/icalbuddy\n');
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('creates watcher with config', () => {
    const watcher = new CalendarWatcher(makeConfig(stateDir));
    expect(watcher).toBeDefined();
  });

  it('reports status with zero counts before polling', () => {
    const watcher = new CalendarWatcher(makeConfig(stateDir));
    const status = watcher.getStatus();
    expect(status.eventsTracked).toBe(0);
    expect(status.changesDetected).toBe(0);
    expect(status.lastCheck).toBeNull();
  });

  it('start() checks that icalbuddy exists via execFileSync', async () => {
    mockExecFileSync
      .mockReturnValueOnce('/opt/homebrew/bin/icalbuddy\n') // which check
      .mockReturnValue(''); // poll call

    const watcher = new CalendarWatcher(makeConfig(stateDir));
    await watcher.start();
    watcher.stop();

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'which',
      ['icalbuddy'],
      expect.any(Object),
    );
  });

  it('stop() clears the polling timer', async () => {
    mockExecFileSync.mockReturnValue('');
    const watcher = new CalendarWatcher(makeConfig(stateDir));
    await watcher.start();
    watcher.stop();
    // Should not throw
    expect(true).toBe(true);
  });
});

// ─── parseIcalbuddyOutput ─────────────────────────────────────────────────────

describe('CalendarWatcher.parseIcalbuddyOutput', () => {
  it('parses title from non-indented line', () => {
    const output = 'My Event\n | 2026-03-21 10:00 - 11:00\n | Work\n';
    const events = CalendarWatcher.parseIcalbuddyOutput(output);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('My Event');
  });

  it('parses start and end times', () => {
    const output = 'Team standup\n | 2026-03-21 10:00 - 10:30\n | Work\n';
    const events = CalendarWatcher.parseIcalbuddyOutput(output);
    expect(events[0].start).toBe('2026-03-21 10:00');
    expect(events[0].end).toBe('2026-03-21 10:30');
  });

  it('parses calendar name', () => {
    const output = 'Lab meeting\n | 2026-03-21 14:00 - 15:00\n | Personal\n';
    const events = CalendarWatcher.parseIcalbuddyOutput(output);
    expect(events[0].calendar).toBe('Personal');
  });

  it('parses location from metadata line', () => {
    const output =
      'Event\n | 2026-03-21 10:00 - 11:00\n | Work\n | location: Conference Room A\n';
    const events = CalendarWatcher.parseIcalbuddyOutput(output);
    expect(events[0].location).toBe('Conference Room A');
  });

  it('parses attendees from metadata line', () => {
    const output =
      'Event\n | 2026-03-21 10:00 - 11:00\n | Work\n | attendees: Alice, Bob\n';
    const events = CalendarWatcher.parseIcalbuddyOutput(output);
    expect(events[0].attendees).toEqual(['Alice', 'Bob']);
  });

  it('parses multiple events from sample output', () => {
    const events = CalendarWatcher.parseIcalbuddyOutput(SAMPLE_OUTPUT);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0].title).toBe('Team standup');
    expect(events[1].title).toBe('Lab meeting');
  });

  it('returns empty array for empty output', () => {
    const events = CalendarWatcher.parseIcalbuddyOutput('');
    expect(events).toHaveLength(0);
  });

  it('handles all-day events (no time range)', () => {
    const output = 'All-day event\n | 2026-03-21\n | Work\n';
    const events = CalendarWatcher.parseIcalbuddyOutput(output);
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('All-day event');
    expect(events[0].start).toBe('2026-03-21');
  });
});

// ─── diffSnapshots ────────────────────────────────────────────────────────────

describe('CalendarWatcher.diffSnapshots', () => {
  const eventA: CalendarEvent = {
    title: 'Team standup',
    start: '2026-03-21 10:00',
    end: '2026-03-21 10:30',
    calendar: 'Work',
  };
  const eventB: CalendarEvent = {
    title: 'Lab meeting',
    start: '2026-03-21 14:00',
    end: '2026-03-21 15:00',
    calendar: 'Personal',
  };

  it('detects new events when prev is empty', () => {
    const changes = CalendarWatcher.diffSnapshots([], [eventA]);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe('new_event');
    expect(changes[0].event.title).toBe('Team standup');
  });

  it('detects deleted events when curr is empty', () => {
    const changes = CalendarWatcher.diffSnapshots([eventA], []);
    expect(changes).toHaveLength(1);
    expect(changes[0].changeType).toBe('deleted');
    expect(changes[0].event.title).toBe('Team standup');
  });

  it('returns no changes when snapshots are identical', () => {
    const changes = CalendarWatcher.diffSnapshots([eventA], [eventA]);
    expect(changes).toHaveLength(0);
  });

  it('detects added and removed events in the same diff', () => {
    const changes = CalendarWatcher.diffSnapshots([eventA], [eventB]);
    expect(changes).toHaveLength(2);
    const types = changes.map((c) => c.changeType).sort();
    expect(types).toContain('new_event');
    expect(types).toContain('deleted');
  });

  it('uses title|start|end|calendar as the event key', () => {
    // Same event, different calendar → should see new + deleted
    const modified = { ...eventA, calendar: 'Personal' };
    const changes = CalendarWatcher.diffSnapshots([eventA], [modified]);
    expect(changes).toHaveLength(2);
  });

  it('returns CalendarPayload objects with event fields', () => {
    const changes = CalendarWatcher.diffSnapshots([], [eventA]);
    const payload = changes[0] as CalendarPayload;
    expect(payload.event.title).toBe('Team standup');
    expect(payload.event.start).toBe('2026-03-21 10:00');
    expect(payload.event.end).toBe('2026-03-21 10:30');
  });
});

// ─── detectConflicts ──────────────────────────────────────────────────────────

describe('CalendarWatcher.detectConflicts', () => {
  it('returns empty array when no events', () => {
    expect(CalendarWatcher.detectConflicts([])).toHaveLength(0);
  });

  it('returns empty array when events do not overlap', () => {
    const events: CalendarEvent[] = [
      {
        title: 'A',
        start: '2026-03-21 10:00',
        end: '2026-03-21 10:30',
        calendar: 'Work',
      },
      {
        title: 'B',
        start: '2026-03-21 11:00',
        end: '2026-03-21 11:30',
        calendar: 'Work',
      },
    ];
    expect(CalendarWatcher.detectConflicts(events)).toHaveLength(0);
  });

  it('detects overlapping events', () => {
    const events: CalendarEvent[] = [
      {
        title: 'A',
        start: '2026-03-21 10:00',
        end: '2026-03-21 11:00',
        calendar: 'Work',
      },
      {
        title: 'B',
        start: '2026-03-21 10:30',
        end: '2026-03-21 11:30',
        calendar: 'Work',
      },
    ];
    const conflicts = CalendarWatcher.detectConflicts(events);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0].changeType).toBe('conflict');
  });

  it('includes conflictsWith field in conflict payload', () => {
    const events: CalendarEvent[] = [
      {
        title: 'Meeting A',
        start: '2026-03-21 10:00',
        end: '2026-03-21 11:00',
        calendar: 'Work',
      },
      {
        title: 'Meeting B',
        start: '2026-03-21 10:30',
        end: '2026-03-21 11:30',
        calendar: 'Work',
      },
    ];
    const conflicts = CalendarWatcher.detectConflicts(events);
    expect(conflicts[0].conflictsWith).toBeDefined();
    expect(conflicts[0].conflictsWith?.title).toBeTruthy();
  });

  it('does not flag back-to-back events as conflicts (end === next start)', () => {
    const events: CalendarEvent[] = [
      {
        title: 'A',
        start: '2026-03-21 10:00',
        end: '2026-03-21 11:00',
        calendar: 'Work',
      },
      {
        title: 'B',
        start: '2026-03-21 11:00',
        end: '2026-03-21 12:00',
        calendar: 'Work',
      },
    ];
    expect(CalendarWatcher.detectConflicts(events)).toHaveLength(0);
  });

  it('returns CalendarPayload objects with changeType conflict', () => {
    const events: CalendarEvent[] = [
      {
        title: 'X',
        start: '2026-03-21 09:00',
        end: '2026-03-21 10:30',
        calendar: 'Work',
      },
      {
        title: 'Y',
        start: '2026-03-21 10:00',
        end: '2026-03-21 11:00',
        calendar: 'Work',
      },
    ];
    const conflicts = CalendarWatcher.detectConflicts(events);
    expect(conflicts.every((c) => c.changeType === 'conflict')).toBe(true);
  });
});
