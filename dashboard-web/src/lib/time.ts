/**
 * Small relative/absolute time helpers. No library — a personal
 * dashboard for one family can get away with ~30 lines of date math
 * and avoid shipping dayjs/luxon/date-fns in the initial bundle.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * "3m ago", "2h ago", "yesterday", "3d ago", "Mar 12".
 * Crosses into absolute format past a week old.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diff = now.getTime() - then.getTime();

  if (Number.isNaN(diff)) return "";
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return "yesterday";
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d ago`;

  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      now.getFullYear() === then.getFullYear() ? undefined : "numeric",
  });
}

/**
 * Absolute display for a date/time, for hover tooltips or when the
 * relative time isn't specific enough (e.g. report metadata).
 */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
