import { TIMEZONE } from './config.js';

/**
 * Build a date/time prefix so the agent knows the current day of week.
 * LLMs cannot reliably derive day-of-week from ISO timestamps alone,
 * so we inject it explicitly into every prompt.
 */
export function datePrefix(): string {
  const now = new Date();
  const localDate = now.toLocaleDateString('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const localTime = now.toLocaleTimeString('en-US', {
    timeZone: TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
  });
  return `[Current date and time: ${localDate}, ${localTime}]\n\n`;
}
