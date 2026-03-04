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
