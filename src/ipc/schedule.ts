import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config.js';

/**
 * Host-side schedule value helpers. Given a validated schedule_type +
 * schedule_value, compute the ISO timestamp of the next run. Returns
 * null when the input is invalid (callers treat null as "skip this task").
 *
 * Separate from the container-side validator (ipc-mcp-stdio/schedule-validator.ts)
 * because it additionally resolves the next-run timestamp using the
 * configured TIMEZONE for cron expressions.
 */

export type ScheduleType = 'cron' | 'interval' | 'once';

export function computeNextRunForCron(value: string): string | null {
  try {
    const interval = CronExpressionParser.parse(value, { tz: TIMEZONE });
    return interval.next().toISOString();
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return null;
  }
}

export function computeNextRunForInterval(
  value: string,
  now: number = Date.now(),
): string | null {
  const ms = parseInt(value, 10);
  if (isNaN(ms) || ms <= 0) return null;
  return new Date(now + ms).toISOString();
}

export function computeNextRunForOnce(value: string): string | null {
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function computeNextRun(
  scheduleType: ScheduleType,
  scheduleValue: string,
): string | null {
  switch (scheduleType) {
    case 'cron':
      return computeNextRunForCron(scheduleValue);
    case 'interval':
      return computeNextRunForInterval(scheduleValue);
    case 'once':
      return computeNextRunForOnce(scheduleValue);
  }
}
