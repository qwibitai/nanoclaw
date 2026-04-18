import fs from 'fs';
import path from 'path';
import os from 'os';
import { google, type calendar_v3 } from 'googleapis';
import { logger } from './logger.js';
import type { CalendarEvent } from './calendar-poller.js';

export interface CalendarAccountConfig {
  label: string;
  credentialsPath: string;
  oauthKeysPath: string;
}

interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
}

interface OAuthKeys {
  installed: {
    client_id: string;
    client_secret: string;
    token_uri: string;
    auth_uri: string;
    redirect_uris: string[];
  };
}

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/**
 * Discover which Gmail-MCP accounts have calendar scope authorized.
 */
export function discoverCalendarAccounts(): CalendarAccountConfig[] {
  const home = os.homedir();
  const dirs = [
    { label: 'personal', dir: path.join(home, '.gmail-mcp') },
    { label: 'jonathan', dir: path.join(home, '.gmail-mcp-jonathan') },
    { label: 'attaxion', dir: path.join(home, '.gmail-mcp-attaxion') },
    { label: 'dev', dir: path.join(home, '.gmail-mcp-dev') },
  ];

  const accounts: CalendarAccountConfig[] = [];

  for (const { label, dir } of dirs) {
    const credsPath = path.join(dir, 'credentials.json');
    const keysPath = path.join(dir, 'gcp-oauth.keys.json');

    if (!fs.existsSync(credsPath) || !fs.existsSync(keysPath)) continue;

    try {
      const creds: StoredCredentials = JSON.parse(
        fs.readFileSync(credsPath, 'utf-8'),
      );
      if (creds.scope && creds.scope.includes(CALENDAR_SCOPE)) {
        accounts.push({
          label,
          credentialsPath: credsPath,
          oauthKeysPath: keysPath,
        });
      }
    } catch {
      // Skip malformed credential files
    }
  }

  return accounts;
}

/**
 * Build an authenticated Google Calendar client from stored credentials.
 */
function buildCalendarClient(
  account: CalendarAccountConfig,
): calendar_v3.Calendar | null {
  try {
    const keys: OAuthKeys = JSON.parse(
      fs.readFileSync(account.oauthKeysPath, 'utf-8'),
    );
    const creds: StoredCredentials = JSON.parse(
      fs.readFileSync(account.credentialsPath, 'utf-8'),
    );

    const oauth2 = new google.auth.OAuth2(
      keys.installed.client_id,
      keys.installed.client_secret,
    );

    oauth2.setCredentials({
      access_token: creds.access_token,
      refresh_token: creds.refresh_token,
      expiry_date: creds.expiry_date,
    });

    // Auto-save refreshed tokens
    oauth2.on('tokens', (tokens) => {
      try {
        const updated = { ...creds, ...tokens };
        if (tokens.expiry_date) updated.expiry_date = tokens.expiry_date;
        fs.writeFileSync(
          account.credentialsPath,
          JSON.stringify(updated, null, 2),
        );
        logger.debug(
          { account: account.label },
          'Calendar OAuth tokens refreshed and saved',
        );
      } catch (err) {
        logger.warn(
          { err, account: account.label },
          'Failed to save refreshed calendar tokens',
        );
      }
    });

    return google.calendar({ version: 'v3', auth: oauth2 });
  } catch (err) {
    logger.warn(
      { err, account: account.label },
      'Failed to build calendar client',
    );
    return null;
  }
}

/**
 * Fetch calendar events from all configured accounts within the given time range.
 */
export async function fetchCalendarEvents(
  fromMs: number,
  toMs: number,
  accounts?: CalendarAccountConfig[],
): Promise<CalendarEvent[]> {
  const targets = accounts ?? discoverCalendarAccounts();

  if (targets.length === 0) {
    logger.debug('No Google accounts with calendar scope found');
    return [];
  }

  const timeMin = new Date(fromMs).toISOString();
  const timeMax = new Date(toMs).toISOString();
  const allEvents: CalendarEvent[] = [];

  for (const account of targets) {
    const calendar = buildCalendarClient(account);
    if (!calendar) continue;

    try {
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50,
      });

      const items = response.data.items ?? [];

      for (const item of items) {
        if (!item.id) continue;

        const startTime = item.start?.dateTime ?? item.start?.date;
        const endTime = item.end?.dateTime ?? item.end?.date;

        if (!startTime || !endTime) continue;

        const attendees = (item.attendees ?? [])
          .map((a) => a.email)
          .filter((e): e is string => !!e);

        allEvents.push({
          id: item.id,
          title: item.summary ?? '',
          start_time: new Date(startTime).getTime(),
          end_time: new Date(endTime).getTime(),
          attendees,
          location: item.location ?? null,
          source_account: account.label,
        });
      }

      logger.debug(
        { account: account.label, count: items.length },
        'Fetched calendar events',
      );
    } catch (err) {
      logger.warn(
        { err, account: account.label },
        'Failed to fetch calendar events (non-fatal)',
      );
    }
  }

  return allEvents;
}
