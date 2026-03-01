#!/usr/bin/env npx tsx
/**
 * Google Calendar Tool for NanoClaw
 *
 * Usage:
 *   npx tsx tools/calendar/calendar.ts list-events --time-min "2026-02-21T00:00:00Z" --time-max "2026-02-28T00:00:00Z"
 *   npx tsx tools/calendar/calendar.ts create-event --summary "Meeting" --start "2026-02-22T10:00:00" --end "2026-02-22T11:00:00"
 *   npx tsx tools/calendar/calendar.ts update-event --event-id "abc123" --summary "Updated Meeting"
 *   npx tsx tools/calendar/calendar.ts delete-event --event-id "abc123"
 *   npx tsx tools/calendar/calendar.ts free-busy --time-min "2026-02-22T00:00:00Z" --time-max "2026-02-22T23:59:59Z"
 *
 * Environment variables:
 *   GOOGLE_SERVICE_ACCOUNT_KEY  — JSON string of the service account key
 *   GOOGLE_CALENDAR_ID          — The calendar ID to manage
 */

import { google, calendar_v3 } from 'googleapis';

type Action = 'list-events' | 'create-event' | 'update-event' | 'delete-event' | 'free-busy';

interface Args {
  action: Action;
  flags: Record<string, string>;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const action = argv[0] as Action;

  const validActions: Action[] = ['list-events', 'create-event', 'update-event', 'delete-event', 'free-busy'];
  if (!validActions.includes(action)) {
    console.error(JSON.stringify({
      status: 'error',
      error: `Unknown action "${action}". Use: ${validActions.join(', ')}`,
      usage: [
        'npx tsx tools/calendar/calendar.ts list-events --time-min "2026-02-21T00:00:00Z" --time-max "2026-02-28T00:00:00Z"',
        'npx tsx tools/calendar/calendar.ts create-event --summary "Meeting" --start "2026-02-22T10:00:00" --end "2026-02-22T11:00:00"',
        'npx tsx tools/calendar/calendar.ts update-event --event-id "abc123" --summary "Updated Title"',
        'npx tsx tools/calendar/calendar.ts delete-event --event-id "abc123"',
        'npx tsx tools/calendar/calendar.ts free-busy --time-min "2026-02-22T00:00:00Z" --time-max "2026-02-22T23:59:59Z"',
      ],
    }));
    process.exit(1);
  }

  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      flags[argv[i].slice(2)] = argv[++i];
    }
  }

  return { action, flags };
}

function getAuth(flags: Record<string, string>): { auth: InstanceType<typeof google.auth.JWT>; calendarId: string } {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const calendarId = flags['calendar-id'] || process.env.GOOGLE_CALENDAR_ID;

  if (!keyJson) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing GOOGLE_SERVICE_ACCOUNT_KEY environment variable. Set it to the JSON string of your service account key.',
    }));
    process.exit(1);
  }
  if (!calendarId) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'Missing calendar ID. Pass --calendar-id or set GOOGLE_CALENDAR_ID environment variable.',
    }));
    process.exit(1);
  }

  let key: { client_email: string; private_key: string };
  try {
    key = JSON.parse(keyJson);
  } catch {
    console.error(JSON.stringify({
      status: 'error',
      error: 'GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON.',
    }));
    process.exit(1);
  }

  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  return { auth, calendarId };
}

function getCalendar(auth: InstanceType<typeof google.auth.JWT>): calendar_v3.Calendar {
  return google.calendar({ version: 'v3', auth });
}

async function listEvents(
  cal: calendar_v3.Calendar,
  calendarId: string,
  flags: Record<string, string>,
) {
  const params: calendar_v3.Params$Resource$Events$List = {
    calendarId,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: parseInt(flags['max-results'] || '50', 10),
  };

  if (flags['time-min']) params.timeMin = flags['time-min'];
  if (flags['time-max']) params.timeMax = flags['time-max'];
  if (flags['q']) params.q = flags['q'];

  const res = await cal.events.list(params);
  const events = (res.data.items || []).map(e => ({
    id: e.id,
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    status: e.status,
    attendees: e.attendees?.map(a => ({ email: a.email, responseStatus: a.responseStatus })),
    meetLink: e.conferenceData?.entryPoints?.find(
      (ep: { entryPointType?: string }) => ep.entryPointType === 'video'
    )?.uri || null,
  }));

  console.log(JSON.stringify({
    status: 'success',
    action: 'list-events',
    events,
    eventCount: events.length,
  }));
}

async function createEvent(
  cal: calendar_v3.Calendar,
  calendarId: string,
  flags: Record<string, string>,
) {
  if (!flags.summary || !flags.start || !flags.end) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'create-event requires --summary, --start, and --end',
    }));
    process.exit(1);
  }

  const event: calendar_v3.Schema$Event = {
    summary: flags.summary,
    start: { dateTime: flags.start, timeZone: flags.timezone || process.env.TZ || 'UTC' },
    end: { dateTime: flags.end, timeZone: flags.timezone || process.env.TZ || 'UTC' },
  };

  if (flags.description) event.description = flags.description;
  if (flags.location) event.location = flags.location;
  if (flags.attendees) {
    try {
      event.attendees = JSON.parse(flags.attendees);
    } catch {
      console.error(JSON.stringify({ status: 'error', error: 'Invalid --attendees JSON. Must be an array: [{"email":"a@b.com"}]' }));
      process.exit(1);
    }
  }

  // Add Google Meet conferencing if --meet flag is set (or by default for all events)
  if (flags.meet !== 'false') {
    event.conferenceData = {
      createRequest: {
        requestId: `meet-${Date.now()}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    };
  }

  const res = await cal.events.insert({
    calendarId,
    requestBody: event,
    conferenceDataVersion: 1,
  });

  console.log(JSON.stringify({
    status: 'success',
    action: 'create-event',
    event: {
      id: res.data.id,
      summary: res.data.summary,
      start: res.data.start?.dateTime || res.data.start?.date,
      end: res.data.end?.dateTime || res.data.end?.date,
      htmlLink: res.data.htmlLink,
      meetLink: res.data.conferenceData?.entryPoints?.find(
        (e: { entryPointType?: string }) => e.entryPointType === 'video'
      )?.uri || null,
    },
  }));
}

async function updateEvent(
  cal: calendar_v3.Calendar,
  calendarId: string,
  flags: Record<string, string>,
) {
  if (!flags['event-id']) {
    console.error(JSON.stringify({ status: 'error', error: 'update-event requires --event-id' }));
    process.exit(1);
  }

  // Fetch existing event first
  const existing = await cal.events.get({ calendarId, eventId: flags['event-id'] });
  const patch: calendar_v3.Schema$Event = {};

  if (flags.summary) patch.summary = flags.summary;
  if (flags.description) patch.description = flags.description;
  if (flags.location) patch.location = flags.location;
  if (flags.start) {
    patch.start = {
      dateTime: flags.start,
      timeZone: flags.timezone || existing.data.start?.timeZone || process.env.TZ || 'UTC',
    };
  }
  if (flags.end) {
    patch.end = {
      dateTime: flags.end,
      timeZone: flags.timezone || existing.data.end?.timeZone || process.env.TZ || 'UTC',
    };
  }

  const res = await cal.events.patch({
    calendarId,
    eventId: flags['event-id'],
    requestBody: patch,
  });

  console.log(JSON.stringify({
    status: 'success',
    action: 'update-event',
    event: {
      id: res.data.id,
      summary: res.data.summary,
      start: res.data.start?.dateTime || res.data.start?.date,
      end: res.data.end?.dateTime || res.data.end?.date,
    },
  }));
}

async function deleteEvent(
  cal: calendar_v3.Calendar,
  calendarId: string,
  flags: Record<string, string>,
) {
  if (!flags['event-id']) {
    console.error(JSON.stringify({ status: 'error', error: 'delete-event requires --event-id' }));
    process.exit(1);
  }

  await cal.events.delete({ calendarId, eventId: flags['event-id'] });

  console.log(JSON.stringify({
    status: 'success',
    action: 'delete-event',
    eventId: flags['event-id'],
  }));
}

async function freeBusy(
  cal: calendar_v3.Calendar,
  calendarId: string,
  flags: Record<string, string>,
) {
  if (!flags['time-min'] || !flags['time-max']) {
    console.error(JSON.stringify({
      status: 'error',
      error: 'free-busy requires --time-min and --time-max',
    }));
    process.exit(1);
  }

  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: flags['time-min'],
      timeMax: flags['time-max'],
      items: [{ id: calendarId }],
    },
  });

  const busySlots = res.data.calendars?.[calendarId]?.busy || [];

  console.log(JSON.stringify({
    status: 'success',
    action: 'free-busy',
    timeMin: flags['time-min'],
    timeMax: flags['time-max'],
    busySlots,
    busyCount: busySlots.length,
  }));
}

async function main() {
  const { action, flags } = parseArgs();
  const { auth, calendarId } = getAuth(flags);
  const cal = getCalendar(auth);

  try {
    switch (action) {
      case 'list-events':
        await listEvents(cal, calendarId, flags);
        break;

      case 'create-event':
        await createEvent(cal, calendarId, flags);
        break;

      case 'update-event':
        await updateEvent(cal, calendarId, flags);
        break;

      case 'delete-event':
        await deleteEvent(cal, calendarId, flags);
        break;

      case 'free-busy':
        await freeBusy(cal, calendarId, flags);
        break;
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    const statusCode = (err as { code?: number })?.code;
    if (statusCode === 401 || statusCode === 403) {
      console.error(JSON.stringify({
        status: 'error',
        error,
        hint: `Google Calendar API returned ${statusCode}. Verify: (1) Calendar API is enabled in Google Cloud Console, (2) The calendar is shared with the service account email (found in GOOGLE_SERVICE_ACCOUNT_KEY → client_email) with at least "Make changes to events" permission, (3) GOOGLE_CALENDAR_ID is correct.`,
      }));
    } else if (statusCode === 404) {
      console.error(JSON.stringify({
        status: 'error',
        error,
        hint: 'Calendar or event not found. Check GOOGLE_CALENDAR_ID and ensure it is shared with the service account.',
      }));
    } else {
      console.error(JSON.stringify({ status: 'error', error }));
    }
    process.exit(1);
  }
}

main();
