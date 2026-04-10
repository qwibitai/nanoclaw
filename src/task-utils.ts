import { CronExpressionParser } from 'cron-parser';

import type { ScheduledTask } from './types.js';

export function createTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function computeTaskNextRun(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
  timezone: string,
): string {
  if (scheduleType === 'cron') {
    const interval = CronExpressionParser.parse(scheduleValue, {
      tz: timezone,
    });
    const next = interval.next();
    if (!next) {
      throw new Error(`Invalid cron expression: ${scheduleValue}`);
    }
    const nextRun = next.toISOString();
    if (!nextRun) {
      throw new Error(`Invalid cron expression: ${scheduleValue}`);
    }
    return nextRun;
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) {
      throw new Error(`Invalid interval: ${scheduleValue}`);
    }
    return new Date(Date.now() + ms).toISOString();
  }

  const date = new Date(scheduleValue);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${scheduleValue}`);
  }
  return date.toISOString();
}
