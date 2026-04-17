import { CronExpressionParser } from 'cron-parser';

/**
 * Pure schedule_value validators used by both `schedule_task` and
 * `update_task` tool handlers. The tool handlers turn a `Invalid`
 * result into an MCP `isError: true` response; integration tests can
 * use these directly to check contract.
 */
export type ScheduleValidation =
  | { valid: true }
  | { valid: false; error: string };

export function validateCron(value: string): ScheduleValidation {
  try {
    CronExpressionParser.parse(value);
    return { valid: true };
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return {
      valid: false,
      error: `Invalid cron: "${value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
    };
  }
}

export function validateInterval(value: string): ScheduleValidation {
  const ms = parseInt(value, 10);
  if (isNaN(ms) || ms <= 0) {
    return {
      valid: false,
      error: `Invalid interval: "${value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
    };
  }
  return { valid: true };
}

export function validateOnce(value: string): ScheduleValidation {
  if (/[Zz]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
    return {
      valid: false,
      error: `Timestamp must be local time without timezone suffix. Got "${value}" — use format like "2026-02-01T15:30:00".`,
    };
  }
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    return {
      valid: false,
      error: `Invalid timestamp: "${value}". Use local time format like "2026-02-01T15:30:00".`,
    };
  }
  return { valid: true };
}

export function validateSchedule(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
): ScheduleValidation {
  switch (scheduleType) {
    case 'cron':
      return validateCron(scheduleValue);
    case 'interval':
      return validateInterval(scheduleValue);
    case 'once':
      return validateOnce(scheduleValue);
  }
}
