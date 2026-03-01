# Intent: src/task-scheduler.ts modifications

## What changed
Added Shabbat/Yom Tov guard to skip scheduled task execution during restricted times.

## Key sections

### Imports (top of file)
- Added: `isShabbatOrYomTov` from `./shabbat.js`

### startSchedulerLoop() → loop()
- Added: early return after `getDueTasks()` if `isShabbatOrYomTov()`
- Due tasks are NOT rescheduled — `next_run` stays unchanged
- Tasks fire on the first scheduler poll after Shabbat ends
- Debug log when skipping due tasks

## Invariants (must-keep)
- All existing task execution, cron parsing, error handling unchanged
- Task status checks (paused/cancelled) unchanged
- Queue interaction unchanged
- Idle timeout handling unchanged
