import { TIMEZONE } from './config.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Format a cron expression into a human-readable string.
 */
function formatCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return `cron: ${expr}`;

  const [minute, hour, dom, month, dow] = parts;

  // Every N minutes: */N * * * *
  if (minute.startsWith('*/') && hour === '*' && dom === '*' && dow === '*') {
    const n = parseInt(minute.slice(2), 10);
    return n === 1 ? 'every minute' : `every ${n} min`;
  }

  // Every N hours: 0 */N * * *
  if (minute === '0' && hour.startsWith('*/') && dom === '*' && dow === '*') {
    const n = parseInt(hour.slice(2), 10);
    return n === 1 ? 'every hour' : `every ${n} hours`;
  }

  // Specific time patterns
  if (hour !== '*' && !hour.includes('/') && !hour.includes(',')) {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10) || 0;
    const ampm = h >= 12 ? 'pm' : 'am';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const timeStr =
      m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;

    // Daily: specific time, * * *
    if (dom === '*' && month === '*' && dow === '*') {
      return `daily at ${timeStr}`;
    }

    // Weekdays: 0 9 * * 1-5
    if (dom === '*' && month === '*' && dow === '1-5') {
      return `weekdays at ${timeStr}`;
    }

    // Specific days of week
    if (dom === '*' && month === '*' && dow !== '*') {
      const dayNames = dow
        .split(',')
        .map((d) => WEEKDAYS[parseInt(d, 10)] || d)
        .join(', ');
      return `${dayNames} at ${timeStr}`;
    }
  }

  return `cron: ${expr}`;
}

/**
 * Format an interval in milliseconds into a human-readable string.
 */
function formatInterval(ms: string): string {
  const val = parseInt(ms, 10);
  if (!val || val <= 0) return `interval: ${ms}ms`;

  if (val < 60_000) return `every ${Math.round(val / 1000)}s`;
  if (val < 3_600_000) return `every ${Math.round(val / 60_000)} min`;
  if (val < 86_400_000) {
    const hours = Math.round(val / 3_600_000);
    return hours === 1 ? 'every hour' : `every ${hours} hours`;
  }
  const days = Math.round(val / 86_400_000);
  return days === 1 ? 'every day' : `every ${days} days`;
}

/**
 * Format a once-type timestamp into a readable date/time.
 */
function formatOnce(timestamp: string): string {
  try {
    const d = new Date(timestamp);
    return `once at ${d.toLocaleString('en-US', { timeZone: TIMEZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  } catch {
    return `once: ${timestamp}`;
  }
}

/**
 * Format a schedule type + value into a human-readable string.
 */
export function formatSchedule(
  type: 'cron' | 'interval' | 'once',
  value: string,
): string {
  switch (type) {
    case 'cron':
      return formatCron(value);
    case 'interval':
      return formatInterval(value);
    case 'once':
      return formatOnce(value);
  }
}

/**
 * Format next run time as a relative/readable string.
 */
export function formatNextRun(nextRun: string | null): string {
  if (!nextRun) return '';
  try {
    const d = new Date(nextRun);
    const now = Date.now();
    const diffMs = d.getTime() - now;

    if (diffMs < 0) return 'overdue';
    if (diffMs < 60_000) return 'in <1 min';
    if (diffMs < 3_600_000) return `in ${Math.round(diffMs / 60_000)} min`;
    if (diffMs < 86_400_000) {
      const hours = Math.round(diffMs / 3_600_000);
      return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
    }

    return d.toLocaleString('en-US', {
      timeZone: TIMEZONE,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
