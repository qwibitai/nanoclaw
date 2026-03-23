import { randomUUID } from 'crypto';
import ICAL from 'ical.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DAVCalendar, DAVObject } from 'tsdav';
import { getCaldavClient } from '../auth.js';
import { ok, err } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string | null;
  description: string | null;
  allDay: boolean;
  url?: string;
  etag?: string;
  calendarName?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch all calendars that have VEVENT component support (i.e. event calendars). */
async function getEventCalendars(): Promise<DAVCalendar[]> {
  const client = await getCaldavClient();
  const calendars = await client.fetchCalendars();
  return calendars.filter(
    (cal) => cal.components && cal.components.includes('VEVENT'),
  );
}

/** Find a single event calendar by display name. */
async function findCalendar(name: string): Promise<DAVCalendar | undefined> {
  const calendars = await getEventCalendars();
  return calendars.find((c) => c.displayName === name);
}

/** Parse iCal data into a structured event object. */
function parseEvent(obj: DAVObject): ParsedEvent | null {
  try {
    if (!obj.data) return null;

    const jcal = ICAL.parse(obj.data as string);
    const comp = new ICAL.Component(jcal);
    const vevent = comp.getFirstSubcomponent('vevent');
    if (!vevent) return null;

    const uid = String(vevent.getFirstPropertyValue('uid') ?? '');
    const summary = String(vevent.getFirstPropertyValue('summary') ?? '');

    const dtstart = vevent.getFirstPropertyValue('dtstart');
    const dtend = vevent.getFirstPropertyValue('dtend');

    const locVal = vevent.getFirstPropertyValue('location');
    const location: string | null = locVal ? String(locVal) : null;

    const descVal = vevent.getFirstPropertyValue('description');
    const description: string | null = descVal ? String(descVal) : null;

    // All-day detection: ical.js Time objects have isDate property
    const allDay = dtstart ? (dtstart as { isDate?: boolean }).isDate === true : false;

    return {
      id: uid,
      title: summary,
      start: dtstart ? dtstart.toString() : '',
      end: dtend ? dtend.toString() : '',
      location,
      description,
      allDay,
      url: obj.url,
      etag: obj.etag,
    };
  } catch {
    return null;
  }
}

/** Build an iCal VEVENT string from fields. */
function buildVeventIcal(fields: {
  uid: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//icloud-tools//EN',
    'BEGIN:VEVENT',
    `UID:${fields.uid}`,
    `DTSTAMP:${formatIcalDate(new Date())}`,
    `SUMMARY:${fields.title}`,
    `DTSTART:${formatIcalDate(new Date(fields.start))}`,
    `DTEND:${formatIcalDate(new Date(fields.end))}`,
  ];

  if (fields.location) {
    lines.push(`LOCATION:${fields.location}`);
  }

  if (fields.description) {
    lines.push(`DESCRIPTION:${fields.description}`);
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

/** Format a Date to iCal UTC timestamp (YYYYMMDDTHHmmssZ). */
function formatIcalDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Search all event calendars for a VEVENT with the given UID.
 * Returns the raw DAVObject and its parent calendar, or null.
 */
async function findEventById(
  id: string,
): Promise<{ obj: DAVObject; calendar: DAVCalendar } | null> {
  const client = await getCaldavClient();
  const calendars = await getEventCalendars();
  for (const cal of calendars) {
    const objects = await client.fetchCalendarObjects({ calendar: cal });
    for (const obj of objects) {
      const parsed = parseEvent(obj);
      if (parsed && parsed.id === id) {
        return { obj, calendar: cal };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler functions
// ---------------------------------------------------------------------------

export async function handleListCalendars() {
  try {
    const calendars = await getEventCalendars();

    const results = calendars.map((cal) => ({
      name: cal.displayName,
      color: (cal as Record<string, unknown>).calendarColor as string | undefined,
      editable: true,
    }));

    return ok(results);
  } catch (e) {
    return err(`Failed to list calendars: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleListEvents(params: {
  calendar?: string;
  start_date: string;
  end_date: string;
}) {
  try {
    const client = await getCaldavClient();
    let calendarsToQuery: DAVCalendar[];

    if (params.calendar) {
      const cal = await findCalendar(params.calendar);
      if (!cal) {
        return err(`Calendar "${params.calendar}" not found`);
      }
      calendarsToQuery = [cal];
    } else {
      calendarsToQuery = await getEventCalendars();
    }

    const timeRange = {
      start: new Date(params.start_date).toISOString(),
      end: new Date(params.end_date).toISOString(),
    };

    const events: ParsedEvent[] = [];
    for (const cal of calendarsToQuery) {
      const objects = await client.fetchCalendarObjects({
        calendar: cal,
        timeRange,
      });
      for (const obj of objects) {
        const parsed = parseEvent(obj);
        if (parsed) {
          parsed.calendarName = String(cal.displayName ?? '');
          events.push(parsed);
        }
      }
    }

    // Sort by start time
    events.sort((a, b) => a.start.localeCompare(b.start));

    // Return public-facing shape
    const result = events.map((ev) => ({
      id: ev.id,
      title: ev.title,
      start: ev.start,
      end: ev.end,
      location: ev.location,
      allDay: ev.allDay,
    }));

    return ok(result);
  } catch (e) {
    return err(`Failed to list events: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleListUpcoming(params: {
  count?: number;
}) {
  try {
    const count = params.count ?? 10;
    const client = await getCaldavClient();
    const calendars = await getEventCalendars();

    const now = new Date();
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + 90);

    const timeRange = {
      start: now.toISOString(),
      end: endDate.toISOString(),
    };

    const events: ParsedEvent[] = [];
    for (const cal of calendars) {
      const objects = await client.fetchCalendarObjects({
        calendar: cal,
        timeRange,
      });
      for (const obj of objects) {
        const parsed = parseEvent(obj);
        if (parsed) {
          parsed.calendarName = String(cal.displayName ?? '');
          events.push(parsed);
        }
      }
    }

    // Sort by start time
    events.sort((a, b) => a.start.localeCompare(b.start));

    // Slice to requested count
    const sliced = events.slice(0, count);

    const result = sliced.map((ev) => ({
      id: ev.id,
      title: ev.title,
      start: ev.start,
      end: ev.end,
      location: ev.location,
      calendar: ev.calendarName,
    }));

    return ok(result);
  } catch (e) {
    return err(`Failed to list upcoming events: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleCreateEvent(params: {
  calendar: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}) {
  try {
    const cal = await findCalendar(params.calendar);
    if (!cal) {
      return err(`Calendar "${params.calendar}" not found`);
    }

    const uid = randomUUID();
    const icalString = buildVeventIcal({
      uid,
      title: params.title,
      start: params.start,
      end: params.end,
      location: params.location,
      description: params.description,
    });

    const client = await getCaldavClient();
    await client.createCalendarObject({
      calendar: cal,
      filename: `${uid}.ics`,
      iCalString: icalString,
    });

    return ok({ id: uid });
  } catch (e) {
    return err(`Failed to create event: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleUpdateEvent(params: {
  id: string;
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  description?: string;
}) {
  try {
    const found = await findEventById(params.id);
    if (!found) {
      return err(`Event "${params.id}" not found`);
    }

    const { obj } = found;
    const parsed = parseEvent(obj)!;

    const updatedIcal = buildVeventIcal({
      uid: parsed.id,
      title: params.title ?? parsed.title,
      start: params.start ?? parsed.start,
      end: params.end ?? parsed.end,
      location: params.location ?? parsed.location ?? undefined,
      description: params.description ?? parsed.description ?? undefined,
    });

    const client = await getCaldavClient();
    await client.updateCalendarObject({
      calendarObject: {
        url: obj.url,
        etag: obj.etag,
        data: updatedIcal,
      },
    });

    return ok({ success: true });
  } catch (e) {
    return err(`Failed to update event: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleDeleteEvent(params: { id: string }) {
  try {
    const found = await findEventById(params.id);
    if (!found) {
      return err(`Event "${params.id}" not found`);
    }

    const { obj } = found;
    const client = await getCaldavClient();
    await client.deleteCalendarObject({
      calendarObject: { url: obj.url, etag: obj.etag },
    });

    return ok({ success: true });
  } catch (e) {
    return err(`Failed to delete event: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// MCP Registration
// ---------------------------------------------------------------------------

export function registerCalendar(server: McpServer): void {
  server.tool(
    'icloud_calendar_list_calendars',
    'List all iCloud event calendars',
    {},
    async () => handleListCalendars(),
  );

  server.tool(
    'icloud_calendar_list_events',
    'List events in a date range, optionally filtered by calendar',
    {
      calendar: z.string().optional().describe('Calendar name to filter by'),
      start_date: z.string().describe('Start date in ISO 8601 format (e.g. 2026-03-01)'),
      end_date: z.string().describe('End date in ISO 8601 format (e.g. 2026-03-31)'),
    },
    async (params) => handleListEvents(params),
  );

  server.tool(
    'icloud_calendar_list_upcoming',
    'List upcoming events (next 90 days), limited by count',
    {
      count: z.number().optional().describe('Maximum number of events to return (default: 10)'),
    },
    async (params) => handleListUpcoming(params),
  );

  server.tool(
    'icloud_calendar_create_event',
    'Create a new event on an iCloud calendar',
    {
      calendar: z.string().describe('Name of the calendar'),
      title: z.string().describe('Event title'),
      start: z.string().describe('Start date/time in ISO 8601 format'),
      end: z.string().describe('End date/time in ISO 8601 format'),
      location: z.string().optional().describe('Event location'),
      description: z.string().optional().describe('Event description'),
    },
    async (params) => handleCreateEvent(params),
  );

  server.tool(
    'icloud_calendar_update_event',
    'Update an existing calendar event',
    {
      id: z.string().describe('UID of the event to update'),
      title: z.string().optional().describe('New title'),
      start: z.string().optional().describe('New start date/time in ISO 8601 format'),
      end: z.string().optional().describe('New end date/time in ISO 8601 format'),
      location: z.string().optional().describe('New location'),
      description: z.string().optional().describe('New description'),
    },
    async (params) => handleUpdateEvent(params),
  );

  server.tool(
    'icloud_calendar_delete_event',
    'Delete a calendar event',
    {
      id: z.string().describe('UID of the event to delete'),
    },
    async (params) => handleDeleteEvent(params),
  );
}
