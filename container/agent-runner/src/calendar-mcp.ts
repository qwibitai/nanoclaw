/**
 * iCloud Calendar MCP Server for NanoClaw
 * Provides CalDAV-based calendar operations via tsdav.
 * Credentials passed via environment variables (main channel only).
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { DAVClient, DAVCalendar, DAVObject } from 'tsdav';
import ical, { VEvent, EventInstance } from 'node-ical';

let davClient: DAVClient | null = null;
let calendars: DAVCalendar[] = [];

function log(message: string): void {
  console.error(`[calendar-mcp] ${message}`);
}

interface CalendarFilter {
  name: string;
  urlFragment?: string; // Optional URL fragment for disambiguation (e.g., "97B8F2C5")
}

/**
 * Parse ICLOUD_CALENDARS env var as comma-separated list.
 * Supports optional URL fragment syntax: "Name::urlFragment" for disambiguation.
 * Examples:
 *   "Personal,Work" - match by name only
 *   "Família::97B8F2C5,Tiago" - match "Família" with URL containing "97B8F2C5", and "Tiago" by name
 * Returns null if not set (meaning all calendars are enabled).
 */
function getEnabledCalendars(): CalendarFilter[] | null {
  const envValue = process.env.ICLOUD_CALENDARS;
  if (!envValue) return null;

  const filters: CalendarFilter[] = [];
  for (const entry of envValue.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const [name, urlFragment] = trimmed.split('::').map((s) => s.trim());
    filters.push({
      name: name.toLowerCase(),
      urlFragment: urlFragment || undefined,
    });
  }

  return filters.length > 0 ? filters : null;
}

function matchesFilter(
  calendar: { displayName?: unknown; url: string },
  filter: CalendarFilter,
): boolean {
  const displayName = calendar.displayName as string | undefined;
  if (!displayName || displayName.toLowerCase() !== filter.name) {
    return false;
  }
  if (filter.urlFragment && !calendar.url.includes(filter.urlFragment)) {
    return false;
  }
  return true;
}

async function getClient(): Promise<DAVClient> {
  if (davClient) return davClient;

  const username = process.env.ICLOUD_USERNAME;
  const password = process.env.ICLOUD_APP_PASSWORD;

  if (!username || !password) {
    throw new Error(
      'iCloud credentials not configured (ICLOUD_USERNAME, ICLOUD_APP_PASSWORD)',
    );
  }

  log('Connecting to iCloud CalDAV...');

  davClient = new DAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: {
      username,
      password,
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });

  await davClient.login();
  log('Connected to iCloud CalDAV');

  // Fetch calendars once on login
  const allCalendars = await davClient.fetchCalendars();
  log(`Found ${allCalendars.length} calendars total`);

  // Filter to enabled calendars if ICLOUD_CALENDARS is set
  const filters = getEnabledCalendars();
  if (filters) {
    calendars = allCalendars.filter((c) =>
      filters.some((f) => matchesFilter(c, f)),
    );
    const filterDesc = filters
      .map((f) => (f.urlFragment ? `${f.name}::${f.urlFragment}` : f.name))
      .join(', ');
    log(`Filtered to ${calendars.length} enabled calendars: ${filterDesc}`);
  } else {
    calendars = allCalendars;
  }

  return davClient;
}

function findCalendar(nameOrUrl: string): DAVCalendar | undefined {
  // Try exact URL match first
  const byUrl = calendars.find((c) => c.url === nameOrUrl);
  if (byUrl) return byUrl;

  // Try case-insensitive name match
  const lower = nameOrUrl.toLowerCase();
  return calendars.find((c) => {
    const displayName = c.displayName as string | undefined;
    return displayName?.toLowerCase() === lower;
  });
}

interface ParsedEvent {
  uid: string;
  url: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  allDay: boolean;
}

function parseIcsEvents(
  calendarObjects: DAVObject[],
  from: Date,
  to: Date,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  // Expand with a wider window to catch RECURRENCE-ID overrides.
  // When an instance of a recurring event is moved (e.g., from Tuesday to Friday),
  // node-ical's expandRecurringEvent only includes the override if the ORIGINAL
  // recurrence date is within the query window. So we expand with extra padding
  // and then filter the results to the actual requested window.
  const paddingMs = 7 * 24 * 60 * 60 * 1000; // 7 days padding
  const expandFrom = new Date(from.getTime() - paddingMs);
  const expandTo = new Date(to.getTime() + paddingMs);

  for (const obj of calendarObjects) {
    if (!obj.data) continue;

    try {
      const parsed = ical.sync.parseICS(obj.data);

      for (const [, component] of Object.entries(parsed)) {
        if (!component || component.type !== 'VEVENT') continue;
        const vevent = component as VEvent;

        // Expand recurring events into individual instances with wider window
        const instances: EventInstance[] = ical.expandRecurringEvent(vevent, {
          from: expandFrom,
          to: expandTo,
          includeOverrides: true,
          excludeExdates: true,
          expandOngoing: true,
        });

        for (const instance of instances) {
          const instanceStart =
            instance.start instanceof Date
              ? instance.start
              : new Date(String(instance.start));
          const instanceEnd =
            instance.end instanceof Date
              ? instance.end
              : new Date(String(instance.end));

          // Filter to requested window (instance overlaps with [from, to])
          if (instanceEnd <= from || instanceStart >= to) {
            continue;
          }

          // Helper to extract string from ParameterValue
          const getStr = (v: unknown): string | undefined => {
            if (!v) return undefined;
            if (typeof v === 'string') return v;
            if (typeof v === 'object' && 'val' in v)
              return (v as { val: string }).val;
            return String(v);
          };

          events.push({
            uid: vevent.uid || '',
            url: obj.url,
            summary: getStr(instance.summary) || '(No title)',
            description: getStr(instance.event.description),
            location: getStr(instance.event.location),
            start: instanceStart.toISOString(),
            end: instanceEnd.toISOString(),
            allDay: instance.isFullDay,
          });
        }
      }
    } catch (err) {
      log(
        `Failed to parse ICS: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return events.sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
}

function formatEventForDisplay(event: ParsedEvent): string {
  const startDate = new Date(event.start);
  const endDate = new Date(event.end);

  const formatTime = (d: Date) =>
    d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const formatDate = (d: Date) =>
    d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

  let timeStr: string;
  if (event.allDay) {
    timeStr = formatDate(startDate) + ' (all day)';
  } else {
    const sameDay = startDate.toDateString() === endDate.toDateString();
    if (sameDay) {
      timeStr = `${formatDate(startDate)} ${formatTime(startDate)} - ${formatTime(endDate)}`;
    } else {
      timeStr = `${formatDate(startDate)} ${formatTime(startDate)} - ${formatDate(endDate)} ${formatTime(endDate)}`;
    }
  }

  let result = `- ${event.summary}\n  ${timeStr}`;
  if (event.location) result += `\n  Location: ${event.location}`;
  if (event.description)
    result += `\n  Note: ${event.description.slice(0, 100)}${event.description.length > 100 ? '...' : ''}`;
  result += `\n  URL: ${event.url}`;

  return result;
}

function generateIcs(event: {
  summary: string;
  start: Date;
  end: Date;
  description?: string;
  location?: string;
  allDay?: boolean;
}): string {
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@nanoclaw`;
  const now = new Date();

  const formatDateTimeUtc = (d: Date) =>
    d
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');

  const formatDateOnly = (d: Date) =>
    d.toISOString().slice(0, 10).replace(/-/g, '');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//NanoClaw//Calendar//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatDateTimeUtc(now)}`,
  ];

  if (event.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${formatDateOnly(event.start)}`);
    lines.push(`DTEND;VALUE=DATE:${formatDateOnly(event.end)}`);
  } else {
    lines.push(`DTSTART:${formatDateTimeUtc(event.start)}`);
    lines.push(`DTEND:${formatDateTimeUtc(event.end)}`);
  }

  lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);

  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }

  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }

  lines.push('END:VEVENT', 'END:VCALENDAR');

  return lines.join('\r\n');
}

function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

export function createCalendarMcp() {
  return createSdkMcpServer({
    name: 'calendar',
    version: '1.0.0',
    tools: [
      tool(
        'list_calendars',
        'List all available calendars.',
        {},
        async () => {
          try {
            await getClient();

            if (calendars.length === 0) {
              return {
                content: [{ type: 'text', text: 'No calendars found.' }],
              };
            }

            const list = calendars
              .map((c) => `- ${c.displayName || '(unnamed)'}\n  URL: ${c.url}`)
              .join('\n\n');

            return {
              content: [{ type: 'text', text: `Calendars:\n\n${list}` }],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      tool(
        'get_events',
        `Fetch events from a calendar. Optionally filter by date range.

Recurring events with moved instances (RECURRENCE-ID overrides) are properly expanded.`,
        {
          calendar: z.string().describe('Calendar name or URL'),
          start_date: z
            .string()
            .optional()
            .describe('Start of date range (ISO 8601, e.g., "2026-02-05")'),
          end_date: z
            .string()
            .optional()
            .describe('End of date range (ISO 8601, e.g., "2026-02-06")'),
        },
        async (args) => {
          try {
            const client = await getClient();
            const calendar = findCalendar(args.calendar);

            if (!calendar) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Calendar not found: "${args.calendar}". Use list_calendars to see available calendars.`,
                  },
                ],
                isError: true,
              };
            }

            // Default to today if no range specified
            const now = new Date();
            const startDate = args.start_date
              ? new Date(args.start_date)
              : new Date(now.setHours(0, 0, 0, 0));
            const endDate = args.end_date
              ? new Date(args.end_date)
              : new Date(startDate.getTime() + 24 * 60 * 60 * 1000);

            // Set end date to end of day if it's the same as start
            if (endDate <= startDate) {
              endDate.setTime(startDate.getTime() + 24 * 60 * 60 * 1000);
            }

            log(
              `Fetching events from ${calendar.displayName}: ${startDate.toISOString()} to ${endDate.toISOString()}`,
            );

            // Fetch ALL calendar objects without time range filter.
            // This is necessary because recurring events with RECURRENCE-ID overrides
            // (moved instances) won't be returned by CalDAV time-range queries if the
            // master event started outside the query window.
            const objects = await client.fetchCalendarObjects({ calendar });

            const events = parseIcsEvents(objects, startDate, endDate);

            if (events.length === 0) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `No events found in "${calendar.displayName}" for the specified date range.`,
                  },
                ],
              };
            }

            const formatted = events.map(formatEventForDisplay).join('\n\n');

            return {
              content: [
                {
                  type: 'text',
                  text: `Events in "${calendar.displayName}" (${events.length}):\n\n${formatted}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      tool(
        'create_event',
        'Create a new calendar event.',
        {
          calendar: z.string().describe('Calendar name or URL'),
          summary: z.string().describe('Event title'),
          start: z
            .string()
            .describe('Start time (ISO 8601, e.g., "2026-02-05T14:00:00")'),
          end: z
            .string()
            .describe('End time (ISO 8601, e.g., "2026-02-05T15:00:00")'),
          description: z
            .string()
            .optional()
            .describe('Event description/notes'),
          location: z.string().optional().describe('Event location'),
          all_day: z.boolean().optional().describe('True for all-day events'),
        },
        async (args) => {
          try {
            const client = await getClient();
            const calendar = findCalendar(args.calendar);

            if (!calendar) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Calendar not found: "${args.calendar}". Use list_calendars to see available calendars.`,
                  },
                ],
                isError: true,
              };
            }

            const startDate = new Date(args.start);
            const endDate = new Date(args.end);

            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Invalid date format. Use ISO 8601 (e.g., "2026-02-05T14:00:00").',
                  },
                ],
                isError: true,
              };
            }

            const icsData = generateIcs({
              summary: args.summary,
              start: startDate,
              end: endDate,
              description: args.description,
              location: args.location,
              allDay: args.all_day,
            });

            const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.ics`;

            await client.createCalendarObject({
              calendar,
              filename,
              iCalString: icsData,
            });

            log(`Created event: ${args.summary}`);

            return {
              content: [
                {
                  type: 'text',
                  text: `Event created: "${args.summary}" on ${startDate.toLocaleDateString()}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      tool(
        'update_event',
        `Update an existing calendar event. Requires the event URL (from get_events).

Note: CalDAV updates require full event replacement. All provided fields will be used; omitted optional fields will be removed from the event.`,
        {
          event_url: z.string().describe('Event URL (from get_events output)'),
          summary: z.string().describe('Event title'),
          start: z.string().describe('Start time (ISO 8601)'),
          end: z.string().describe('End time (ISO 8601)'),
          description: z
            .string()
            .optional()
            .describe('Event description/notes'),
          location: z.string().optional().describe('Event location'),
          all_day: z.boolean().optional().describe('True for all-day events'),
        },
        async (args) => {
          try {
            const client = await getClient();

            const startDate = new Date(args.start);
            const endDate = new Date(args.end);

            if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
              return {
                content: [
                  { type: 'text', text: 'Invalid date format. Use ISO 8601.' },
                ],
                isError: true,
              };
            }

            const icsData = generateIcs({
              summary: args.summary,
              start: startDate,
              end: endDate,
              description: args.description,
              location: args.location,
              allDay: args.all_day,
            });

            await client.updateCalendarObject({
              calendarObject: {
                url: args.event_url,
                data: icsData,
              },
            });

            log(`Updated event: ${args.summary}`);

            return {
              content: [
                { type: 'text', text: `Event updated: "${args.summary}"` },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      tool(
        'delete_event',
        'Delete a calendar event by URL.',
        {
          event_url: z.string().describe('Event URL (from get_events output)'),
        },
        async (args) => {
          try {
            const client = await getClient();

            await client.deleteCalendarObject({
              calendarObject: {
                url: args.event_url,
              },
            });

            log(`Deleted event: ${args.event_url}`);

            return {
              content: [{ type: 'text', text: 'Event deleted.' }],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Error: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
