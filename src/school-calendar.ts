/**
 * School Bytes calendar integration.
 *
 * Fetches the school calendar from School Bytes' public ICS export URL.
 * Caches the parsed events with a configurable TTL since school events
 * change infrequently.
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import type { CalendarEvent } from './icloud-calendar.js';

const DEFAULT_URL =
  'https://online.schoolbytes.education/calendar_export_ical/4830/af67a497-b471-481e-b8d4-52041c73cfba';
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

let cachedEvents: CalendarEvent[] = [];
let lastFetchTime = 0;

function getUrl(): string {
  const env = readEnvFile(['SCHOOL_BYTES_CALENDAR_URL']);
  return env.SCHOOL_BYTES_CALENDAR_URL || DEFAULT_URL;
}

/**
 * Parse ICS content into CalendarEvent objects.
 */
function parseICS(content: string): CalendarEvent[] {
  const unfolded = content
    .replace(/\r\n /g, '')
    .replace(/\r\n\t/g, '')
    .replace(/\n /g, '')
    .replace(/\n\t/g, '');

  const lines = unfolded.split(/\r?\n/);
  const events: CalendarEvent[] = [];

  let inEvent = false;
  let uid = '';
  let summary = '';
  let dtstart = '';
  let dtend = '';
  let description: string | null = null;
  let location: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'BEGIN:VEVENT') {
      inEvent = true;
      uid = '';
      summary = '';
      dtstart = '';
      dtend = '';
      description = null;
      location = null;
      continue;
    }
    if (trimmed === 'END:VEVENT') {
      inEvent = false;
      const start = parseICSDate(dtstart);
      if (start) {
        const isAllDay = dtstart.includes('VALUE=DATE');
        const end = parseICSDate(dtend);
        const cleanLocation = location
          ? location
              .replace(/\\,/g, ',')
              .replace(/\\;/g, ';')
              .replace(/\\n/g, ' ')
              .trim()
          : null;
        events.push({
          id: uid || `school-${Date.now()}-${Math.random()}`,
          summary: summary.replace(/\\,/g, ',').replace(/\\;/g, ';'),
          startDate: start.toISOString(),
          endDate: end ? end.toISOString() : null,
          isAllDay,
          description: description
            ? description.replace(/\\n/g, '\n').replace(/\\,/g, ',').trim()
            : null,
          location:
            cleanLocation && cleanLocation.length > 0 ? cleanLocation : null,
          source: 'School',
          calendarUrl: null,
        });
      }
      continue;
    }
    if (!inEvent) continue;

    if (trimmed.startsWith('UID:')) uid = trimmed.slice(4);
    else if (trimmed.startsWith('SUMMARY:')) summary = trimmed.slice(8);
    else if (trimmed.startsWith('DTSTART')) dtstart = trimmed;
    else if (trimmed.startsWith('DTEND')) dtend = trimmed;
    else if (trimmed.startsWith('DESCRIPTION:'))
      description = trimmed.slice(12);
    else if (trimmed.startsWith('LOCATION:')) location = trimmed.slice(9);
  }

  return events;
}

function parseICSDate(raw: string): Date | null {
  if (!raw) return null;
  const colonIdx = raw.lastIndexOf(':');
  if (colonIdx === -1) return null;
  const value = raw.slice(colonIdx + 1);

  const y = parseInt(value.slice(0, 4));
  const m = parseInt(value.slice(4, 6)) - 1;
  const d = parseInt(value.slice(6, 8));

  if (raw.includes('VALUE=DATE')) {
    return new Date(y, m, d);
  }

  const h = parseInt(value.slice(9, 11));
  const min = parseInt(value.slice(11, 13));
  const s = parseInt(value.slice(13, 15));

  if (value.endsWith('Z')) {
    return new Date(Date.UTC(y, m, d, h, min, s));
  }
  return new Date(y, m, d, h, min, s);
}

/**
 * Fetch and cache school calendar events.
 */
async function fetchAndCache(): Promise<void> {
  const url = getUrl();

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`School Bytes returned ${response.status}`);
    }

    const icsContent = await response.text();
    cachedEvents = parseICS(icsContent);
    lastFetchTime = Date.now();

    logger.info({ eventCount: cachedEvents.length }, 'School calendar fetched');
  } catch (err) {
    logger.error({ err }, 'Failed to fetch school calendar');
    // Keep stale cache if we have one — better than nothing
  }
}

/**
 * Get school calendar events for a date range.
 * Uses cached data, refreshing if the cache is stale.
 */
export async function getSchoolEvents(
  start: Date,
  end: Date,
): Promise<CalendarEvent[]> {
  // Refresh cache if stale
  if (Date.now() - lastFetchTime > CACHE_TTL_MS) {
    await fetchAndCache();
  }

  const startISO = start.toISOString();
  const endISO = end.toISOString();

  return cachedEvents.filter((e) => {
    return e.startDate >= startISO && e.startDate < endISO;
  });
}

/**
 * Check if school calendar is available (has cached data or can fetch).
 */
export async function isSchoolCalendarAvailable(): Promise<boolean> {
  if (cachedEvents.length > 0) return true;
  await fetchAndCache();
  return cachedEvents.length > 0;
}
