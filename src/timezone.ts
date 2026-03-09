/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 *
 * Returns a fallback string if the timestamp or timezone is invalid,
 * rather than silently producing "Invalid Date" or throwing.
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  if (isNaN(date.getTime())) {
    return utcIso || 'unknown time';
  }
  try {
    return date.toLocaleString('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    // Invalid timezone — fall back to UTC ISO string
    return date.toISOString();
  }
}
