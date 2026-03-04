import { TIMEZONE } from './config.js';
import { RegisteredGroup } from './types.js';

/**
 * Resolve the effective timezone for a group.
 * Falls back to the server-level TIMEZONE from config.
 */
export function resolveGroupTimezone(group: RegisteredGroup): string {
  return group.containerConfig?.timezone || TIMEZONE;
}

/**
 * Validate an IANA timezone string.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Get the current time formatted for a timezone, for injection into prompts.
 */
export function formatCurrentTime(timezone: string): string {
  const now = new Date();
  const formatted = now.toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const tzAbbr = now
    .toLocaleString('en-US', {
      timeZone: timezone,
      timeZoneName: 'short',
    })
    .split(', ')
    .pop()!
    .split(' ')
    .pop()!;
  return `${formatted} ${tzAbbr}`;
}

function getDateParts(
  date: Date,
  tz: string,
): { day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  return {
    day: parseInt(parts.find((p) => p.type === 'day')!.value),
    hour: parseInt(parts.find((p) => p.type === 'hour')!.value),
    minute: parseInt(parts.find((p) => p.type === 'minute')!.value),
  };
}

/**
 * Parse a local time string (without Z suffix) as if it were in the given timezone,
 * and return a UTC ISO string for storage.
 *
 * Uses Intl API to determine the UTC offset for the given timezone at the
 * given local time, then applies the inverse.
 *
 * DST handling:
 * - Spring forward (gap): advances to next valid time
 * - Fall back (overlap): uses first occurrence
 */
export function localTimeToUtc(localTimeStr: string, timezone: string): string {
  // Parse as if UTC to get a reference point
  const naive = new Date(localTimeStr + 'Z');
  if (isNaN(naive.getTime())) {
    throw new Error(`Invalid timestamp: "${localTimeStr}"`);
  }

  // Find the UTC offset at that point in the target timezone
  const utcParts = getDateParts(naive, 'UTC');
  const localParts = getDateParts(naive, timezone);

  // Compute offset in minutes (local - UTC)
  let offsetMinutes =
    localParts.hour * 60 +
    localParts.minute -
    (utcParts.hour * 60 + utcParts.minute);

  // Handle day boundary crossing
  if (localParts.day !== utcParts.day) {
    offsetMinutes += (localParts.day > utcParts.day ? 1 : -1) * 24 * 60;
  }

  // Apply inverse offset: user's local time - offset = UTC time
  const utcMs = naive.getTime() - offsetMinutes * 60_000;
  const result = new Date(utcMs);

  // DST gap handling: Intl resolves to the post-transition offset automatically,
  // so the result is already the closest valid UTC time after a spring-forward gap.

  return result.toISOString();
}
