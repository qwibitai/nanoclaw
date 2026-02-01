import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

export type ScheduleType = 'cron' | 'interval' | 'once';

export interface ScheduleValidationResult {
  valid: boolean;
  error?: string;
  nextRun?: string | null;
}

/**
 * Validates a schedule value based on its type.
 * Returns validation result with next run time if valid.
 */
export function validateSchedule(
  scheduleType: ScheduleType,
  scheduleValue: string
): ScheduleValidationResult {
  switch (scheduleType) {
    case 'cron':
      return validateCronExpression(scheduleValue);
    case 'interval':
      return validateInterval(scheduleValue);
    case 'once':
      return validateOnceTimestamp(scheduleValue);
    default:
      return { valid: false, error: `Unknown schedule type: ${scheduleType}` };
  }
}

/**
 * Validates a cron expression and returns the next run time if valid.
 */
export function validateCronExpression(expression: string): ScheduleValidationResult {
  try {
    const interval = CronExpressionParser.parse(expression);
    const nextRun = interval.next().toISOString();
    return { valid: true, nextRun };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      error: `Invalid cron expression "${expression}": ${message}. Use standard cron format (e.g., "0 9 * * *" for daily at 9am, "*/5 * * * *" for every 5 minutes).`
    };
  }
}

/**
 * Validates an interval value (milliseconds) and returns the next run time if valid.
 */
export function validateInterval(value: string): ScheduleValidationResult {
  const ms = parseInt(value, 10);

  if (isNaN(ms)) {
    return {
      valid: false,
      error: `Invalid interval "${value}": must be a number (milliseconds). Use values like "300000" for 5 minutes or "3600000" for 1 hour.`
    };
  }

  if (ms <= 0) {
    return {
      valid: false,
      error: `Invalid interval "${value}": must be a positive number. Use values like "300000" for 5 minutes.`
    };
  }

  if (ms < 60000) {
    return {
      valid: false,
      error: `Interval ${ms}ms is too short. Minimum interval is 60000ms (1 minute).`
    };
  }

  const nextRun = new Date(Date.now() + ms).toISOString();
  return { valid: true, nextRun };
}

/**
 * Validates a one-time timestamp (ISO 8601) and returns it as the next run time if valid.
 */
export function validateOnceTimestamp(timestamp: string): ScheduleValidationResult {
  const date = new Date(timestamp);

  if (isNaN(date.getTime())) {
    return {
      valid: false,
      error: `Invalid timestamp "${timestamp}": must be a valid ISO 8601 date (e.g., "2026-02-01T15:30:00.000Z").`
    };
  }

  if (date.getTime() <= Date.now()) {
    return {
      valid: false,
      error: `Timestamp "${timestamp}" is in the past. Please provide a future date/time.`
    };
  }

  return { valid: true, nextRun: date.toISOString() };
}

export function loadJson<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch {
    // Return default on error
  }
  return defaultValue;
}

export function saveJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
