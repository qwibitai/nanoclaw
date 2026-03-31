/**
 * Unified calendar service.
 *
 * Merges events from iCloud CalDAV (family calendar) and School Bytes
 * (school calendar) into a single sorted stream. Consumers (daily nudge,
 * This Week view, agent skills) call this instead of individual sources.
 */

import {
  getICloudEvents,
  isICloudAvailable,
  type CalendarEvent,
} from './icloud-calendar.js';
import {
  getSchoolEvents,
  isSchoolCalendarAvailable,
} from './school-calendar.js';
import { logger } from './logger.js';

export type { CalendarEvent } from './icloud-calendar.js';

/**
 * Get events for a date range from all calendar sources.
 * Returns merged, sorted events tagged with their source.
 */
export async function getEvents(
  start: Date,
  end: Date,
): Promise<CalendarEvent[]> {
  const results = await Promise.allSettled([
    getICloudEvents(start, end),
    getSchoolEvents(start, end),
  ]);

  const events: CalendarEvent[] = [];
  const errors: string[] = [];

  if (results[0].status === 'fulfilled') {
    events.push(...results[0].value);
  } else {
    errors.push(`iCloud: ${results[0].reason}`);
  }

  if (results[1].status === 'fulfilled') {
    events.push(...results[1].value);
  } else {
    errors.push(`School: ${results[1].reason}`);
  }

  if (errors.length > 0) {
    logger.warn({ errors }, 'Some calendar sources failed');
  }

  // Sort by start date, all-day events first within each day
  events.sort((a, b) => {
    const dateCompare = a.startDate.localeCompare(b.startDate);
    if (dateCompare !== 0) return dateCompare;
    if (a.isAllDay && !b.isAllDay) return -1;
    if (!a.isAllDay && b.isAllDay) return 1;
    return 0;
  });

  return events;
}

/**
 * Get today's events from all sources.
 */
export async function getTodayEvents(): Promise<CalendarEvent[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return getEvents(today, tomorrow);
}

/**
 * Get this week's events from all sources.
 */
export async function getThisWeekEvents(): Promise<CalendarEvent[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekEnd = new Date(today);
  weekEnd.setDate(weekEnd.getDate() + 7);
  return getEvents(today, weekEnd);
}

/**
 * Check if any calendar source is available.
 * Returns details about which sources are up/down.
 */
export async function getCalendarStatus(): Promise<{
  anyAvailable: boolean;
  icloud: boolean;
  school: boolean;
}> {
  const [icloud, school] = await Promise.all([
    isICloudAvailable().catch(() => false),
    isSchoolCalendarAvailable().catch(() => false),
  ]);

  return {
    anyAvailable: icloud || school,
    icloud,
    school,
  };
}
