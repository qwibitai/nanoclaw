/**
 * CalendarWatcher for NanoClaw Phase 2
 *
 * Polls the macOS icalbuddy CLI to detect calendar event changes and conflicts,
 * then routes detected changes to the EventRouter.
 *
 * Uses execFileSync with array arguments (no shell interpolation).
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import type { CalendarPayload } from '../classification-prompts.js';
import type { EventRouter } from '../event-router.js';

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  location?: string;
  calendar?: string;
  attendees?: string[];
}

export interface CalendarWatcherConfig {
  calendars: string[];
  eventRouter: Pick<EventRouter, 'route'>;
  pollIntervalMs: number;
  lookAheadDays: number;
  stateDir: string;
}

// ─── Internal ─────────────────────────────────────────────────────────────────

const SNAPSHOT_FILE = 'calendar-snapshot.json';
const ICALBUDDY_BIN = '/opt/homebrew/bin/icalbuddy';

// ─── CalendarWatcher ──────────────────────────────────────────────────────────

export class CalendarWatcher {
  private config: CalendarWatcherConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCheck: string | null = null;
  private eventsTracked = 0;
  private changesDetected = 0;

  constructor(config: CalendarWatcherConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    // Verify icalbuddy is available
    try {
      execFileSync('which', ['icalbuddy'], {
        encoding: 'utf-8',
        timeout: 5_000,
      });
    } catch (err) {
      logger.warn({ err }, 'icalbuddy not found — calendar watcher disabled');
      return;
    }

    logger.info(
      {
        calendars: this.config.calendars,
        pollIntervalMs: this.config.pollIntervalMs,
      },
      'CalendarWatcher starting',
    );

    // Run first poll immediately, then on interval
    await this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('CalendarWatcher stopped');
  }

  getStatus(): {
    lastCheck: string | null;
    eventsTracked: number;
    changesDetected: number;
  } {
    return {
      lastCheck: this.lastCheck,
      eventsTracked: this.eventsTracked,
      changesDetected: this.changesDetected,
    };
  }

  // ─── Static Parsers ─────────────────────────────────────────────────────────

  /**
   * Parse icalbuddy text output into CalendarEvent[].
   *
   * Format:
   *   Event title          (non-indented line)
   *    | 2026-03-21 10:00 - 10:30   (date/time range, starts with " | ")
   *    | CalendarName               (calendar name)
   *    | location: ...              (optional)
   *    | attendees: ...             (optional)
   */
  static parseIcalbuddyOutput(output: string): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    let current: Partial<CalendarEvent> | null = null;
    // Track whether we've seen the date line for the current event
    let sawDateLine = false;
    // Track how many metadata lines (after the title) we've seen that aren't date/calendar/location/attendees
    let calendarLineConsumed = false;

    const lines = output.split('\n');

    for (const raw of lines) {
      // Non-indented, non-empty line = new event title
      if (
        raw.length > 0 &&
        raw[0] !== ' ' &&
        raw[0] !== '\t' &&
        raw[0] !== '|'
      ) {
        // Save previous event if complete
        if (current?.title) {
          events.push(current as CalendarEvent);
        }
        current = { title: raw.trim() };
        sawDateLine = false;
        calendarLineConsumed = false;
        continue;
      }

      if (!current) continue;

      // Metadata line: " | ..."
      const metaMatch = raw.match(/^\s+\|\s+(.*)/);
      if (!metaMatch) continue;
      const value = metaMatch[1].trim();

      // location: prefix
      if (value.startsWith('location:')) {
        current.location = value.slice('location:'.length).trim();
        continue;
      }

      // attendees: prefix
      if (value.startsWith('attendees:')) {
        const attendeeStr = value.slice('attendees:'.length).trim();
        current.attendees = attendeeStr
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean);
        continue;
      }

      // Date/time line: "2026-03-21 10:00 - 10:30"  or  "2026-03-21"
      if (!sawDateLine) {
        const rangeMatch = value.match(
          /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+-\s+(\d{2}:\d{2})$/,
        );
        if (rangeMatch) {
          const [, date, startTime, endTime] = rangeMatch;
          current.start = `${date} ${startTime}`;
          current.end = `${date} ${endTime}`;
          sawDateLine = true;
          continue;
        }
        const allDayMatch = value.match(/^(\d{4}-\d{2}-\d{2})$/);
        if (allDayMatch) {
          current.start = allDayMatch[1];
          current.end = allDayMatch[1];
          sawDateLine = true;
          continue;
        }
      }

      // Calendar name line (first non-date/location/attendees metadata line after date)
      if (sawDateLine && !calendarLineConsumed) {
        // Skip lines that look like other prefixed metadata we already handled
        if (!value.includes(':')) {
          current.calendar = value;
          calendarLineConsumed = true;
          continue;
        }
      }
    }

    // Push final event
    if (current?.title) {
      events.push(current as CalendarEvent);
    }

    return events;
  }

  /**
   * Diff two snapshots; return CalendarPayload[] for new and deleted events.
   * Events are keyed by "title|start|end|calendar".
   */
  static diffSnapshots(
    prev: CalendarEvent[],
    curr: CalendarEvent[],
  ): CalendarPayload[] {
    const key = (e: CalendarEvent) =>
      `${e.title}|${e.start}|${e.end}|${e.calendar ?? ''}`;

    const prevMap = new Map(prev.map((e) => [key(e), e]));
    const currMap = new Map(curr.map((e) => [key(e), e]));

    const changes: CalendarPayload[] = [];

    // New events
    for (const [k, event] of currMap) {
      if (!prevMap.has(k)) {
        changes.push({
          changeType: 'new_event',
          event: {
            title: event.title,
            start: event.start,
            end: event.end,
            location: event.location,
            calendar: event.calendar,
            attendees: event.attendees,
          },
        });
      }
    }

    // Deleted events
    for (const [k, event] of prevMap) {
      if (!currMap.has(k)) {
        changes.push({
          changeType: 'deleted',
          event: {
            title: event.title,
            start: event.start,
            end: event.end,
            location: event.location,
            calendar: event.calendar,
            attendees: event.attendees,
          },
        });
      }
    }

    return changes;
  }

  /**
   * Detect overlapping events. Events are sorted by start time; any pair
   * where event[i].end > event[i+1].start is a conflict.
   * Back-to-back events (end === next start) are NOT conflicts.
   */
  static detectConflicts(events: CalendarEvent[]): CalendarPayload[] {
    if (events.length < 2) return [];

    // Sort by start ascending
    const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));

    const conflicts: CalendarPayload[] = [];

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        // b starts at or after a ends → no more conflicts for a
        if (b.start >= a.end) break;
        // Overlap: b starts before a ends (strict)
        conflicts.push({
          changeType: 'conflict',
          event: {
            title: a.title,
            start: a.start,
            end: a.end,
            location: a.location,
            calendar: a.calendar,
            attendees: a.attendees,
          },
          conflictsWith: {
            title: b.title,
            start: b.start,
            end: b.end,
          },
        });
      }
    }

    return conflicts;
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      const calendarsArg = this.config.calendars.join(',');
      const output = execFileSync(
        ICALBUDDY_BIN,
        [
          '-ic',
          calendarsArg,
          '-df',
          '%Y-%m-%d',
          '-tf',
          '%H:%M',
          '-b',
          '',
          '-nc',
          '-nrd',
          'eventsFrom:today',
          `to:+${this.config.lookAheadDays}d`,
        ],
        { encoding: 'utf-8', timeout: 10_000 },
      );

      const curr = CalendarWatcher.parseIcalbuddyOutput(output);
      const prev = this.loadSnapshot();

      const changes = CalendarWatcher.diffSnapshots(prev, curr);
      const conflicts = CalendarWatcher.detectConflicts(curr);

      this.eventsTracked = curr.length;
      this.lastCheck = new Date().toISOString();

      if (changes.length > 0 || conflicts.length > 0) {
        this.changesDetected += changes.length + conflicts.length;

        logger.info(
          { changes: changes.length, conflicts: conflicts.length },
          'CalendarWatcher: changes detected',
        );

        for (const payload of [...changes, ...conflicts]) {
          await this.config.eventRouter.route({
            type: 'calendar',
            id: `cal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            timestamp: new Date().toISOString(),
            payload: payload as unknown as Record<string, unknown>,
          });
        }
      }

      this.saveSnapshot(curr);
    } catch (err) {
      logger.warn({ err }, 'CalendarWatcher poll error');
    }
  }

  private snapshotPath(): string {
    return path.join(this.config.stateDir, SNAPSHOT_FILE);
  }

  private loadSnapshot(): CalendarEvent[] {
    try {
      const raw = fs.readFileSync(this.snapshotPath(), 'utf-8');
      return JSON.parse(raw) as CalendarEvent[];
    } catch {
      return [];
    }
  }

  private saveSnapshot(events: CalendarEvent[]): void {
    try {
      fs.mkdirSync(this.config.stateDir, { recursive: true });
      fs.writeFileSync(
        this.snapshotPath(),
        JSON.stringify(events, null, 2),
        'utf-8',
      );
    } catch (err) {
      logger.warn({ err }, 'CalendarWatcher: failed to save snapshot');
    }
  }
}
