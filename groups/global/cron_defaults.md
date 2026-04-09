# Cron and timezone defaults

## Default timezone: America/Chicago

**All** scheduled tasks, date boundaries, timestamp writes, "today" calculations, and reveal cutoffs use **America/Chicago** unless a specific person explicitly asks for a different zone for their personal reminder.

This matches the timestamp convention in `/workspace/global/date_time_convention.md`. Mixing zones across groups causes real bugs (a pump logged at 11:30 PM in one zone can look like "tomorrow" in another).

## Cron field format

Use standard 5-field cron syntax in UTC-free form (the scheduler applies the timezone you specify):

```
minute  hour  day-of-month  month  day-of-week
```

When scheduling, always pass the timezone explicitly: `America/Chicago`. Do not rely on the container's default.

## Common schedules (copy-paste ready)

| Purpose | Cron | Notes |
|---|---|---|
| Daily at 5 AM | `0 5 * * *` | Calendar card refresh |
| Daily at 6 AM | `0 6 * * *` | Wordle rollover |
| Daily at 8 AM | `0 8 * * *` | Panda question post |
| Every 2 min | `*/2 * * * *` | High-frequency pollers — MUST be script-gated |
| Every 10 min, 7 AM–11 PM | `*/10 7-23 * * *` | Daytime poller (more efficient than every 2 min) |
| Weekly Mon 9 AM | `0 9 * * 1` | Weekly summaries |

## Throttling guidance

- **Every 2 min pollers** are acceptable IF the gating script reads state in <1s and returns `wakeAgent: false` on the common path. Otherwise move to every 5 or 10 min.
- **Night hours (11 PM–7 AM)**: most household pollers should skip this window. Use `*/10 7-23 * * *` rather than `*/10 * * * *`.
- **Every minute or faster**: never. Talk to the user if you think you need it.

## Script-gating is mandatory

Anything that fires more than once a day MUST include a bash gating script. See `/workspace/global/task_scripts.md`.
