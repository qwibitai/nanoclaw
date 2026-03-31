/**
 * iCloud Calendar integration via CalDAV.
 *
 * Connects to iCloud using an app-specific password and reads
 * family calendar events. Polls for changes using ctag dirty-checking.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { DAVClient, DAVCalendar, DAVObject } from 'tsdav';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

let client: DAVClient | null = null;
let calendars: DAVCalendar[] = [];
let initialized = false;

interface ICloudConfig {
  appleId: string;
  appPassword: string;
  calendarNames: string[];
}

const CREDS_PATH = path.join(
  os.homedir(),
  '.config',
  'nanoclaw',
  'icloud-caldav',
  'credentials.json',
);

function loadConfig(): ICloudConfig | null {
  // Read credentials from ~/.config/nanoclaw/icloud-caldav/credentials.json
  let appleId: string | undefined;
  let appPassword: string | undefined;

  try {
    const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'));
    appleId = creds.appleId;
    appPassword = creds.appPassword;
  } catch {
    logger.warn(
      { path: CREDS_PATH },
      'iCloud CalDAV credentials file not found',
    );
  }

  if (!appleId || !appPassword) {
    logger.warn('iCloud CalDAV not configured — missing credentials');
    return null;
  }

  // Calendar names still from .env (not sensitive)
  const env = readEnvFile(['ICLOUD_CALENDAR_NAMES']);

  return {
    appleId,
    appPassword,
    calendarNames: env.ICLOUD_CALENDAR_NAMES
      ? env.ICLOUD_CALENDAR_NAMES.split(',').map((n) => n.trim())
      : [],
  };
}

async function ensureClient(): Promise<DAVClient | null> {
  if (client && initialized) return client;

  const config = loadConfig();
  if (!config) return null;

  try {
    client = new DAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: {
        username: config.appleId,
        password: config.appPassword,
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });

    await client.login();

    // Fetch all visible calendars
    calendars = await client.fetchCalendars();
    logger.info(
      { calendars: calendars.map((c) => c.displayName) },
      'iCloud CalDAV connected',
    );

    // Filter to configured calendar names if specified
    if (config.calendarNames.length > 0) {
      calendars = calendars.filter((c) => {
        const displayName = String(c.displayName || '')
          .toLowerCase()
          .trim();
        return config.calendarNames.some((name) =>
          displayName.startsWith(name.toLowerCase()),
        );
      });
      logger.info(
        { filtered: calendars.map((c) => c.displayName) },
        'Filtered to configured calendars',
      );
    }

    initialized = true;
    return client;
  } catch (err) {
    logger.error({ err }, 'Failed to connect to iCloud CalDAV');
    client = null;
    initialized = false;
    return null;
  }
}

export interface CalendarEvent {
  id: string;
  summary: string;
  startDate: string; // ISO string
  endDate: string | null;
  isAllDay: boolean;
  description: string | null;
  source: string; // calendar display name
  calendarUrl: string | null; // for deep-linking
}

/**
 * Parse a VEVENT from ICS data into a CalendarEvent.
 */
function parseVEvent(
  icsData: string,
  calendarName: string,
): CalendarEvent | null {
  const lines = icsData.split(/\r?\n/);
  let inEvent = false;
  let uid = '';
  let summary = '';
  let dtstart = '';
  let dtend = '';
  let description: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      continue;
    }
    if (line === 'END:VEVENT') {
      inEvent = false;
      break;
    }
    if (!inEvent) continue;

    if (line.startsWith('UID:')) uid = line.slice(4);
    else if (line.startsWith('SUMMARY:')) summary = line.slice(8);
    else if (line.startsWith('DTSTART')) dtstart = line;
    else if (line.startsWith('DTEND')) dtend = line;
    else if (line.startsWith('DESCRIPTION:')) description = line.slice(12);
  }

  const start = parseICSDate(dtstart);
  if (!start) return null;

  const isAllDay = dtstart.includes('VALUE=DATE');
  const end = parseICSDate(dtend);

  return {
    id: uid || `ical-${Date.now()}-${Math.random()}`,
    summary: summary
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\n/g, ' '),
    startDate: start.toISOString(),
    endDate: end ? end.toISOString() : null,
    isAllDay,
    description: description
      ? description.replace(/\\n/g, '\n').replace(/\\,/g, ',').trim()
      : null,
    source: calendarName,
    calendarUrl: null,
  };
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
 * Get events for a date range from all configured iCloud calendars.
 */
export async function getICloudEvents(
  start: Date,
  end: Date,
): Promise<CalendarEvent[]> {
  const davClient = await ensureClient();
  if (!davClient) return [];

  const allEvents: CalendarEvent[] = [];

  for (const calendar of calendars) {
    try {
      const objects: DAVObject[] = await davClient.fetchCalendarObjects({
        calendar,
        timeRange: {
          start: start.toISOString(),
          end: end.toISOString(),
        },
        expand: true,
      });

      for (const obj of objects) {
        if (!obj.data) continue;
        const icsData =
          typeof obj.data === 'string' ? obj.data : String(obj.data);
        const event = parseVEvent(
          icsData,
          String(calendar.displayName || 'Unknown'),
        );
        if (event) {
          event.calendarUrl = obj.url || null;
          allEvents.push(event);
        }
      }
    } catch (err) {
      logger.error(
        { err, calendar: calendar.displayName },
        'Failed to fetch iCloud calendar events',
      );
    }
  }

  allEvents.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return allEvents;
}

/**
 * Check if iCloud CalDAV is configured and reachable.
 */
export async function isICloudAvailable(): Promise<boolean> {
  const davClient = await ensureClient();
  return davClient !== null;
}

/**
 * Reset the client (e.g., after credential change).
 */
export function resetICloudClient(): void {
  client = null;
  calendars = [];
  initialized = false;
}

// MARK: - Background Polling

const POLL_INTERVAL_MS = 60_000; // 60 seconds
let storedCtags: Map<string, string> = new Map();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let onChangeCallback: (() => void) | null = null;

/**
 * Start background polling for calendar changes.
 * Checks ctag every 60 seconds — if changed, calls the callback.
 */
export function startICloudPolling(onChange?: () => void): void {
  if (pollTimer) return; // already polling

  onChangeCallback = onChange || null;

  pollTimer = setInterval(async () => {
    try {
      const davClient = await ensureClient();
      if (!davClient) return;

      let changed = false;

      for (const calendar of calendars) {
        // Re-fetch calendar metadata to get current ctag
        const refreshed = await davClient.fetchCalendars();
        const match = refreshed.find((c) => c.url === calendar.url);
        if (!match) continue;

        const currentCtag = String(
          (match as Record<string, unknown>).ctag || '',
        );
        const storedCtag = storedCtags.get(calendar.url || '') || '';

        if (currentCtag && currentCtag !== storedCtag) {
          storedCtags.set(calendar.url || '', currentCtag);
          changed = true;
          logger.info(
            { calendar: calendar.displayName },
            'iCloud calendar changed (ctag updated)',
          );
        }
      }

      if (changed && onChangeCallback) {
        onChangeCallback();
      }
    } catch (err) {
      logger.debug({ err }, 'iCloud poll check failed (will retry)');
    }
  }, POLL_INTERVAL_MS);

  logger.info(
    { intervalMs: POLL_INTERVAL_MS },
    'iCloud CalDAV polling started',
  );
}

/**
 * Stop background polling.
 */
export function stopICloudPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
