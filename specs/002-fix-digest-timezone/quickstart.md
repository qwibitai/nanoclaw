# Quickstart: Fix Duplicate Daily Digests (Timezone Drift)

**Branch**: `002-fix-digest-timezone` | **Date**: 2026-03-17

## Overview

This fix prevents duplicate daily digest executions caused by timezone drift between restarts. It adds a `created_tz` column to scheduled tasks, backfills existing rows as `'UTC'`, and recomputes `next_run` for cron tasks on startup when the stored timezone does not match the current `TIMEZONE`.

## Files to Change

| File | Change |
|------|--------|
| `src/types.ts` | Add `created_tz: string` to `ScheduledTask` interface |
| `src/db.ts` | Migration: add `created_tz` column. New `updateTaskTimezone()`. Modify `createTask()` to include `created_tz`. |
| `src/task-scheduler.ts` | New `rehydrateTaskTimezones()` function. Export for use by `index.ts`. |
| `src/ipc.ts` | Pass `TIMEZONE` as `created_tz` when creating tasks in `schedule_task` handler |
| `src/index.ts` | Call `rehydrateTaskTimezones()` during startup, after `initDatabase()` and `loadState()` |
| `src/task-scheduler.test.ts` | Tests for rehydration: corrects drifted cron, skips interval/once, skips already-correct, corrects paused, logs corrections |

## Build & Test

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Build
npm run build
```

## Key Design Decisions

1. **Detection by `created_tz` string comparison** (not by recomputing and comparing `next_run` values)
2. **Per-task atomic updates** (single UPDATE per task, no wrapping transaction)
3. **Idempotent** -- if interrupted, uncorrected tasks self-correct on next startup
4. **Paused tasks included** -- because `resume_task` does not recompute `next_run`
5. **Interval and once tasks excluded** -- timezone-independent by nature

## Verification

After deployment, verify with:

```bash
# Check that created_tz column exists and is populated
sqlite3 store/messages.db "SELECT id, schedule_type, created_tz, next_run FROM scheduled_tasks"

# Restart NanoClaw and check logs for correction entries
# Look for log lines with taskId, oldNextRun, newNextRun, oldTz, newTz
```
