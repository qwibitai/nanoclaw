/**
 * Shared utility functions.
 *
 * nowISO() — Use for display timestamps and complaint lifecycle timestamps.
 *   Strips milliseconds to produce "2026-02-12T09:00:00Z" format.
 *   For internal DB timestamps where millisecond precision matters,
 *   use `new Date().toISOString()` directly instead.
 */

/** ISO timestamp without milliseconds (matches project convention). */
export function nowISO(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Format a snake_case status string for display (e.g. "in_progress" -> "In Progress"). */
export function formatStatus(status: string): string {
  return status
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Normalize a phone string by stripping leading +, spaces, and dashes,
 * then validate that the result is 7-15 digits only.
 * Returns the cleaned phone string, or throws if invalid.
 */
export function normalizePhone(raw: string): string {
  const cleaned = raw.replace(/[+\s-]/g, '');
  if (!/^\d{7,15}$/.test(cleaned)) {
    throw new Error(
      `Invalid phone number '${raw}': must be 7-15 digits after stripping +, spaces, dashes.`,
    );
  }
  return cleaned;
}
