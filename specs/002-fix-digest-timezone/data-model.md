# Data Model: Fix Duplicate Daily Digests (Timezone Drift)

**Branch**: `002-fix-digest-timezone` | **Date**: 2026-03-17

## Entity Changes

### ScheduledTask (modified)

**Table**: `scheduled_tasks`

| Column | Type | Default | New? | Notes |
|--------|------|---------|------|-------|
| id | TEXT | (PK) | No | |
| group_folder | TEXT | NOT NULL | No | |
| chat_jid | TEXT | NOT NULL | No | |
| prompt | TEXT | NOT NULL | No | |
| schedule_type | TEXT | NOT NULL | No | `'cron' \| 'interval' \| 'once'` |
| schedule_value | TEXT | NOT NULL | No | |
| context_mode | TEXT | `'isolated'` | No | `'group' \| 'isolated'` |
| next_run | TEXT | NULL | No | ISO 8601 UTC timestamp |
| last_run | TEXT | NULL | No | |
| last_result | TEXT | NULL | No | |
| status | TEXT | `'active'` | No | `'active' \| 'paused' \| 'completed'` |
| created_at | TEXT | NOT NULL | No | |
| **created_tz** | **TEXT** | **`'UTC'`** | **Yes** | **IANA timezone identifier (e.g., `America/Chicago`). Records the timezone under which the task was created. Used to detect drift on restart.** |

### TypeScript Interface Change

```typescript
// src/types.ts — ScheduledTask interface
export interface ScheduledTask {
  // ... existing fields unchanged ...
  created_tz: string;  // NEW: IANA timezone identifier
}
```

## Migration

**Strategy**: `ALTER TABLE ADD COLUMN` with try/catch (existing pattern).

```sql
ALTER TABLE scheduled_tasks ADD COLUMN created_tz TEXT DEFAULT 'UTC'
```

- Existing rows get `created_tz = 'UTC'` (conservative assumption: these tasks were most likely created when `TZ` was not set, defaulting to UTC).
- New rows created after migration get `created_tz` set to the current `TIMEZONE` value from `src/config.ts`.

**Location**: `src/db.ts`, `createSchema()` function, after the existing `context_mode` migration block.

## State Transitions

### Rehydration Flow (startup)

```
For each task WHERE schedule_type = 'cron' AND status IN ('active', 'paused'):
  IF task.created_tz != TIMEZONE:
    1. Recompute next_run using CronExpressionParser.parse(schedule_value, { tz: TIMEZONE })
    2. UPDATE scheduled_tasks SET next_run = ?, created_tz = ? WHERE id = ?
    3. Log correction: { taskId, oldNextRun, newNextRun, oldTz: created_tz, newTz: TIMEZONE }
  ELSE:
    Skip (no correction needed)
```

### Task Creation Flow (IPC `schedule_task`)

```
When creating a new cron/interval/once task:
  1. Set created_tz = TIMEZONE (from src/config.ts)
  2. Persist via createTask() — includes created_tz in INSERT
```

## Validation Rules

- `created_tz` must be a non-empty string (IANA timezone identifier).
- `created_tz` defaults to `'UTC'` for pre-migration rows.
- After rehydration, `created_tz` must equal the current `TIMEZONE` for all corrected tasks.

## DB Function Changes

### New: `updateTaskTimezone(id, nextRun, createdTz)`

Atomic update of `next_run` and `created_tz` in a single UPDATE statement. Used exclusively by the rehydration function.

```sql
UPDATE scheduled_tasks SET next_run = ?, created_tz = ? WHERE id = ?
```

### Modified: `createTask()`

The INSERT statement adds `created_tz` to the column list and values.

### Modified: `updateTask()`

The `updateTask()` function's `updates` parameter type is extended to include `created_tz`.
