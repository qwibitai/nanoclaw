import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';

/**
 * Computes the next run time for a scheduled task.
 * For 'once' tasks returns null (no repeat after first run).
 */
export function computeNextRun(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
    return interval.next().toISOString();
  }
  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    return new Date(Date.now() + ms).toISOString();
  }
  // 'once' — no next run
  return null;
}
