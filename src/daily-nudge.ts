/**
 * Daily nudge — sends a morning push notification with today's calendar events.
 *
 * Uses the unified calendar service (iCloud + School Bytes) instead of
 * static ICS files. For the POC, this is a lightweight function (no Claude
 * agent involved). Content generation can evolve to be agent-driven later.
 */

import { CronExpressionParser } from 'cron-parser';

import { sendPushToAll } from './apns.js';
import { getTodayEvents, getCalendarStatus, type CalendarEvent } from './calendar-service.js';
import { TIMEZONE } from './config.js';
import { logger } from './logger.js';

/**
 * Format a notification body from today's events.
 */
function formatNotificationBody(
  events: CalendarEvent[],
  calendarAvailable: boolean,
): { title: string; body: string } {
  if (!calendarAvailable) {
    return {
      title: "Couldn't Check Calendar",
      body: "Calendar sources are unreachable — check manually today.",
    };
  }

  if (events.length === 0) {
    return {
      title: 'All Clear Today',
      body: 'Nothing on the calendar — enjoy your day!',
    };
  }

  const MAX_EVENTS = 4;
  const shown = events.slice(0, MAX_EVENTS);
  const remaining = events.length - MAX_EVENTS;

  const lines = shown.map(e => {
    const startDate = new Date(e.startDate);
    if (e.isAllDay) {
      return `All day — ${e.summary}`;
    }
    const time = startDate.toLocaleTimeString('en-AU', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return `${time} ${e.summary}`;
  });

  if (remaining > 0) {
    lines.push(`+${remaining} more`);
  }

  return {
    title: "Today's Schedule",
    body: lines.join('\n'),
  };
}

/**
 * Run the daily nudge — fetch calendar events, compose notification, send to all devices.
 * Exported so the test endpoint can call it directly.
 */
export async function runDailyNudge(): Promise<{ title: string; body: string; sent: number }> {
  const status = await getCalendarStatus();
  const events = await getTodayEvents();
  const { title, body } = formatNotificationBody(events, status.anyAvailable);

  logger.info(
    { eventCount: events.length, title, icloud: status.icloud, school: status.school },
    'Running daily nudge',
  );

  const sent = await sendPushToAll(title, body);
  return { title, body, sent };
}

/**
 * Start the daily nudge cron. Runs at 7:30am in the configured timezone.
 */
export function startDailyNudgeCron(): void {
  const CRON_EXPRESSION = '30 7 * * *'; // 7:30am daily

  const scheduleNext = () => {
    const interval = CronExpressionParser.parse(CRON_EXPRESSION, { tz: TIMEZONE });
    const nextRun = interval.next().toDate();
    const delay = nextRun.getTime() - Date.now();

    logger.info({ nextRun: nextRun.toISOString(), timezone: TIMEZONE }, 'Daily nudge scheduled');

    setTimeout(async () => {
      try {
        await runDailyNudge();
      } catch (err) {
        logger.error({ err }, 'Daily nudge failed');
      }
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}
