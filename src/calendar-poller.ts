import {
  CALENDAR_LOOKAHEAD_MS,
  CALENDAR_POLL_INTERVAL,
  ONECLI_URL,
} from './config.js';
import { getDb } from './db.js';
import { eventBus } from './event-bus.js';
import { logger } from './logger.js';

export interface CalendarEvent {
  id: string;
  title: string;
  start_time: number;
  end_time: number;
  attendees: string[];
  location: string | null;
  source_account: string | null;
}

/**
 * Parse a flexible time value into epoch milliseconds.
 * Accepts: epoch number (ms or s), ISO string, or Google Calendar {dateTime: string} object.
 */
function parseTime(value: unknown): number {
  if (typeof value === 'number') {
    // Heuristic: if < 1e12 it's epoch seconds, otherwise epoch ms
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    return new Date(value).getTime();
  }
  if (value && typeof value === 'object' && 'dateTime' in value) {
    return new Date((value as { dateTime: string }).dateTime).getTime();
  }
  throw new Error(`Cannot parse time value: ${JSON.stringify(value)}`);
}

/**
 * Extract attendee emails from either string[] or {email: string}[] shapes.
 */
function extractAttendees(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'email' in item) {
        return (item as { email: string }).email;
      }
      return null;
    })
    .filter((v): v is string => v !== null);
}

/**
 * Store calendar events using INSERT OR REPLACE (upsert) in a transaction.
 */
export function storeCalendarEvents(events: CalendarEvent[]): void {
  if (events.length === 0) return;

  const db = getDb();
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO calendar_events (id, title, start_time, end_time, attendees, location, source_account, fetched_at)
    VALUES (@id, @title, @start_time, @end_time, @attendees, @location, @source_account, @fetched_at)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      attendees = excluded.attendees,
      location = excluded.location,
      source_account = excluded.source_account,
      fetched_at = excluded.fetched_at
  `);

  const tx = db.transaction((evts: CalendarEvent[]) => {
    for (const evt of evts) {
      insert.run({
        id: evt.id,
        title: evt.title,
        start_time: evt.start_time,
        end_time: evt.end_time,
        attendees: JSON.stringify(evt.attendees),
        location: evt.location ?? null,
        source_account: evt.source_account ?? null,
        fetched_at: now,
      });
    }
  });

  tx(events);
  logger.debug({ count: events.length }, 'Stored calendar events');
}

function rowToEvent(row: Record<string, unknown>): CalendarEvent {
  return {
    id: row['id'] as string,
    title: row['title'] as string,
    start_time: row['start_time'] as number,
    end_time: row['end_time'] as number,
    attendees: JSON.parse((row['attendees'] as string) || '[]') as string[],
    location: (row['location'] as string | null) ?? null,
    source_account: (row['source_account'] as string | null) ?? null,
  };
}

/**
 * Returns events where end_time > now AND start_time <= now + lookaheadMs.
 */
export function getUpcomingEvents(
  now: number,
  lookaheadMs: number,
): CalendarEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM calendar_events
       WHERE end_time > @now AND start_time <= @window
       ORDER BY start_time ASC`,
    )
    .all({ now, window: now + lookaheadMs }) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

/**
 * Returns events overlapping the given time range (start_time < rangeEnd AND end_time > rangeStart).
 */
export function getEventsInRange(
  rangeStart: number,
  rangeEnd: number,
): CalendarEvent[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM calendar_events
       WHERE start_time < @rangeEnd AND end_time > @rangeStart
       ORDER BY start_time ASC`,
    )
    .all({ rangeStart, rangeEnd }) as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

/**
 * Poll the OneCLI gateway for calendar events and store them.
 */
export async function pollCalendar(): Promise<void> {
  const now = Date.now();
  const url = `${ONECLI_URL}/calendar/events?from=${now}&to=${now + CALENDAR_LOOKAHEAD_MS}`;

  logger.debug({ url }, 'Polling calendar');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Calendar poll failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as {
    events: Array<{
      id: string;
      summary?: string;
      title?: string;
      start: unknown;
      end: unknown;
      attendees?: unknown[];
      location?: string;
      organizer?: unknown;
      source_account?: string;
    }>;
  };

  const rawEvents = data.events ?? [];
  const events: CalendarEvent[] = rawEvents.map((raw) => ({
    id: raw.id,
    title: raw.title ?? raw.summary ?? '',
    start_time: parseTime(raw.start),
    end_time: parseTime(raw.end),
    attendees: extractAttendees(raw.attendees),
    location: raw.location ?? null,
    source_account: raw.source_account ?? null,
  }));

  storeCalendarEvents(events);

  eventBus.emit('calendar.synced', {
    type: 'calendar.synced',
    source: 'calendar-poller',
    timestamp: now,
    payload: { eventsFound: events.length, lookaheadMs: CALENDAR_LOOKAHEAD_MS },
  });

  logger.info({ eventsFound: events.length }, 'Calendar poll complete');
}

let pollerTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the recurring calendar poller.
 */
export function startCalendarPoller(): void {
  if (pollerTimer !== null) {
    logger.warn('Calendar poller already running');
    return;
  }
  // Run immediately, then on interval
  pollCalendar().catch((err: unknown) => {
    logger.error({ err }, 'Calendar poll error');
  });
  pollerTimer = setInterval(() => {
    pollCalendar().catch((err: unknown) => {
      logger.error({ err }, 'Calendar poll error');
    });
  }, CALENDAR_POLL_INTERVAL);
  logger.info({ intervalMs: CALENDAR_POLL_INTERVAL }, 'Calendar poller started');
}

/**
 * Stop the recurring calendar poller.
 */
export function stopCalendarPoller(): void {
  if (pollerTimer !== null) {
    clearInterval(pollerTimer);
    pollerTimer = null;
    logger.info('Calendar poller stopped');
  }
}

/**
 * Remove calendar events older than olderThanMs milliseconds (default: 7 days).
 */
export function cleanupOldEvents(olderThanMs = 7 * 24 * 60 * 60 * 1000): void {
  const cutoff = Date.now() - olderThanMs;
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM calendar_events WHERE end_time < @cutoff`)
    .run({ cutoff });
  logger.debug(
    { deleted: result.changes, cutoff },
    'Cleaned up old calendar events',
  );
}
