/**
 * Tiny cron / interval / once humanizer for ScheduledTask.schedule_value.
 *
 * Not a full cron parser — handles the most common shapes Boris
 * actually schedules and falls back to the raw value for anything
 * else. No library dependency — 'every weekday at 9am' is 30 lines
 * of tightly-scoped string work.
 */

import type { ScheduledTask } from "@/types";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES: Record<string, string> = {
  "0": "Sun",
  "1": "Mon",
  "2": "Tue",
  "3": "Wed",
  "4": "Thu",
  "5": "Fri",
  "6": "Sat",
  "7": "Sun",
  MON: "Mon",
  TUE: "Tue",
  WED: "Wed",
  THU: "Thu",
  FRI: "Fri",
  SAT: "Sat",
  SUN: "Sun",
};

function formatHourMinute(hour: string, minute: string): string {
  const h = Number(hour);
  const m = Number(minute);
  if (Number.isNaN(h) || Number.isNaN(m)) return `${hour}:${minute}`;
  const period = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  if (m === 0) return `${h12}${period}`;
  return `${h12}:${m.toString().padStart(2, "0")}${period}`;
}

function humanizeDayPart(day: string): string {
  if (day === "*") return "every day";
  if (day === "1-5" || day.toUpperCase() === "MON-FRI") return "weekdays";
  if (day === "0,6" || day === "6,0") return "weekends";
  const parts = day.split(",").map((d) => DAY_NAMES[d.trim().toUpperCase()] ?? d.trim());
  if (parts.length <= 3) return parts.join(", ");
  return day;
}

/**
 * Parse a cron expression. Supports: `m h * * d` (5-field) and the
 * subset Boris actually uses. Anything unrecognized falls back to
 * the raw value.
 */
function humanizeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return expr;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  // Simple "every N minutes" — */N * * * *
  if (
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*" &&
    minute.startsWith("*/")
  ) {
    const n = minute.slice(2);
    return `every ${n} minutes`;
  }

  // "at h:mm" daily — m h * * *
  if (
    !minute.includes("/") &&
    !hour.includes("/") &&
    !minute.includes(",") &&
    !hour.includes(",") &&
    dayOfMonth === "*" &&
    month === "*"
  ) {
    const time = formatHourMinute(hour, minute);
    if (dayOfWeek === "*") return `every day at ${time}`;
    return `${humanizeDayPart(dayOfWeek)} at ${time}`;
  }

  return expr;
}

export function humanizeSchedule(task: ScheduledTask): string {
  const { schedule_type, schedule_value } = task;
  if (schedule_type === "cron") return humanizeCron(schedule_value);
  if (schedule_type === "interval") return `every ${schedule_value}`;
  if (schedule_type === "once") {
    const d = new Date(schedule_value);
    if (Number.isNaN(d.getTime())) return schedule_value;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return schedule_value;
}

// Re-export days array in case a future view wants to render a
// column set or legend.
export { DAYS };
