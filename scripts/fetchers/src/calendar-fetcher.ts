import path from 'path';
import { google } from 'googleapis';
import { DATA_DIR } from './shared/config.js';
import { writeJsonAtomic } from './shared/writer.js';
import { getGoogleAuth } from './shared/google-auth.js';

const TIMEZONE = 'Europe/London';
const CALENDAR_DIR = path.join(DATA_DIR, 'calendar');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CalendarEvent {
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  meeting_link: string | null;
  attendees: string[];
  status: string;
}

interface CalendarOutput {
  fetched_at: string;
  date: string;
  events: CalendarEvent[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date as HH:MM in the Europe/London timezone.
 */
function toHHMM(date: Date): string {
  return date.toLocaleTimeString('en-GB', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Return midnight (00:00:00) today in Europe/London as a Date.
 */
function todayMidnight(): Date {
  // Build a date string for today in the target timezone, then parse it back.
  const nowStr = new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // YYYY-MM-DD
  // Interpret that date string as midnight UTC+0 is wrong; we need the local
  // midnight. The easiest cross-platform approach: create an ISO string with
  // an offset derived from Intl.
  const offsetMs = getTimezoneOffsetMs(TIMEZONE);
  const midnightUtc = new Date(`${nowStr}T00:00:00Z`);
  // Adjust: midnightUtc is midnight UTC, but we want midnight London time.
  // London midnight = UTC midnight - offsetMs (because offset is how far ahead
  // London is of UTC, so London midnight is *earlier* in UTC).
  midnightUtc.setTime(midnightUtc.getTime() - offsetMs);
  return midnightUtc;
}

/**
 * Return the Europe/London UTC offset in milliseconds at the current moment.
 * Positive means ahead of UTC (e.g. BST = +60 min = +3600000 ms).
 */
function getTimezoneOffsetMs(tz: string): number {
  const now = new Date();
  // Format the same instant in UTC and in the target TZ, then diff.
  const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' });
  const tzStr = now.toLocaleString('en-US', { timeZone: tz });
  const utcDate = new Date(utcStr);
  const tzDate = new Date(tzStr);
  return tzDate.getTime() - utcDate.getTime();
}

/**
 * Extract a meeting link from an event, checking hangoutLink first, then
 * conferenceData entry points.
 */
function extractMeetingLink(
  event: {
    hangoutLink?: string | null;
    conferenceData?: {
      entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
    } | null;
  },
): string | null {
  if (event.hangoutLink) {
    return event.hangoutLink;
  }
  const entryPoints = event.conferenceData?.entryPoints;
  if (entryPoints && entryPoints.length > 0) {
    // Prefer video entry points, fall back to first available.
    const video = entryPoints.find((ep) => ep.entryPointType === 'video');
    const chosen = video ?? entryPoints[0];
    return chosen?.uri ?? null;
  }
  return null;
}

/**
 * Return true if the authenticated user has declined this event.
 */
function isDeclined(
  attendees: Array<{ self?: boolean; responseStatus?: string }> | undefined,
): boolean {
  if (!attendees) return false;
  const self = attendees.find((a) => a.self === true);
  return self?.responseStatus === 'declined';
}

/**
 * Transform a raw Google Calendar event into our CalendarEvent shape.
 * `timeFormat` controls whether times are rendered as HH:MM or full ISO.
 */
function transformEvent(
  event: {
    summary?: string | null;
    start?: { dateTime?: string | null; date?: string | null } | null;
    end?: { dateTime?: string | null; date?: string | null } | null;
    location?: string | null;
    hangoutLink?: string | null;
    conferenceData?: {
      entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
    } | null;
    attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }> | null;
    status?: string | null;
  },
  timeFormat: 'hhmm' | 'iso',
): CalendarEvent {
  const allDay = !event.start?.dateTime;

  let startStr: string;
  let endStr: string;

  if (allDay) {
    // All-day events use the date string directly.
    startStr = event.start?.date ?? '';
    endStr = event.end?.date ?? '';
  } else if (timeFormat === 'hhmm') {
    startStr = toHHMM(new Date(event.start!.dateTime!));
    endStr = toHHMM(new Date(event.end!.dateTime!));
  } else {
    startStr = event.start!.dateTime!;
    endStr = event.end!.dateTime!;
  }

  const attendeeEmails = (event.attendees ?? [])
    .map((a) => a.email ?? '')
    .filter(Boolean);

  return {
    title: event.summary ?? '(No title)',
    start: startStr,
    end: endStr,
    all_day: allDay,
    location: event.location ?? null,
    meeting_link: extractMeetingLink(event),
    attendees: attendeeEmails,
    status: event.status ?? 'confirmed',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stderr.write('[calendar-fetcher] Starting...\n');

  const oauth2Client = await getGoogleAuth();
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const now = new Date();
  const fetchedAt = now.toISOString();

  // Today's date string in Europe/London (YYYY-MM-DD).
  const todayDateStr = now.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

  const midnight = todayMidnight();
  const todayStart = midnight.toISOString();

  // Today end: 23:59:59 in London time = midnight + 86399 seconds.
  const todayEndDate = new Date(midnight.getTime() + 86399 * 1000);
  const todayEnd = todayEndDate.toISOString();

  // Week end: midnight + 7 days.
  const weekEndDate = new Date(midnight.getTime() + 7 * 24 * 60 * 60 * 1000);
  const weekEnd = weekEndDate.toISOString();

  // -------------------------------------------------------------------------
  // Fetch today's events
  // -------------------------------------------------------------------------
  process.stderr.write(`[calendar-fetcher] Fetching today's events (${todayDateStr})...\n`);

  const todayResp = await calendar.events.list({
    calendarId: 'primary',
    timeMin: todayStart,
    timeMax: todayEnd,
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: TIMEZONE,
  });

  const todayRawEvents = todayResp.data.items ?? [];
  process.stderr.write(`[calendar-fetcher] Got ${todayRawEvents.length} event(s) for today.\n`);

  const todayEvents: CalendarEvent[] = todayRawEvents
    .filter((ev) => !isDeclined(ev.attendees as Array<{ self?: boolean; responseStatus?: string }> | undefined))
    .map((ev) => transformEvent(ev as Parameters<typeof transformEvent>[0], 'hhmm'));

  const todayOutput: CalendarOutput = {
    fetched_at: fetchedAt,
    date: todayDateStr,
    events: todayEvents,
  };

  // -------------------------------------------------------------------------
  // Fetch this week's events
  // -------------------------------------------------------------------------
  process.stderr.write('[calendar-fetcher] Fetching this week\'s events...\n');

  const weekResp = await calendar.events.list({
    calendarId: 'primary',
    timeMin: todayStart,
    timeMax: weekEnd,
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: TIMEZONE,
  });

  const weekRawEvents = weekResp.data.items ?? [];
  process.stderr.write(`[calendar-fetcher] Got ${weekRawEvents.length} event(s) for the week.\n`);

  const weekEndDateStr = weekEndDate.toLocaleDateString('en-CA', { timeZone: TIMEZONE });

  const weekEvents: CalendarEvent[] = weekRawEvents
    .filter((ev) => !isDeclined(ev.attendees as Array<{ self?: boolean; responseStatus?: string }> | undefined))
    .map((ev) => transformEvent(ev as Parameters<typeof transformEvent>[0], 'iso'));

  const weekOutput: CalendarOutput = {
    fetched_at: fetchedAt,
    date: `${todayDateStr}/${weekEndDateStr}`,
    events: weekEvents,
  };

  // -------------------------------------------------------------------------
  // Write output files
  // -------------------------------------------------------------------------
  const todayPath = path.join(CALENDAR_DIR, 'today.json');
  const weekPath = path.join(CALENDAR_DIR, 'week.json');

  process.stderr.write(`[calendar-fetcher] Writing ${todayPath}...\n`);
  writeJsonAtomic(todayPath, todayOutput);

  process.stderr.write(`[calendar-fetcher] Writing ${weekPath}...\n`);
  writeJsonAtomic(weekPath, weekOutput);

  process.stderr.write('[calendar-fetcher] Done.\n');
}

main().catch((err) => {
  process.stderr.write(`[calendar-fetcher] Fatal error: ${err}\n`);
  process.exit(1);
});
