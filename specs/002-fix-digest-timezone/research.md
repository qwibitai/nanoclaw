# Research: Fix Duplicate Daily Digests (Timezone Drift)

**Branch**: `002-fix-digest-timezone` | **Date**: 2026-03-17

## R1: SQLite Migration Strategy for `created_tz` Column

**Decision**: Use `ALTER TABLE ... ADD COLUMN` with a `DEFAULT 'UTC'` in a try/catch block, matching the existing migration pattern in `db.ts`.

**Rationale**: The codebase already uses this pattern for `context_mode`, `is_bot_message`, `is_main`, `channel`, and `is_group` columns. SQLite supports `ALTER TABLE ADD COLUMN` and automatically backfills the default for existing rows. The try/catch suppresses the "duplicate column" error on subsequent startups.

**Alternatives considered**:
- Formal migration framework (e.g., `umzug`, `knex`): Rejected. YAGNI -- the project has no migration framework and the existing pattern works well for single-column additions.
- Schema versioning table: Rejected. Adds complexity for a single-column migration. The try/catch pattern is idempotent.

## R2: Cron Expression Re-evaluation with Timezone

**Decision**: Use `CronExpressionParser.parse(schedule_value, { tz: TIMEZONE })` from `cron-parser` 5.x to recompute `next_run` during rehydration.

**Rationale**: This is exactly the same API already used in `computeNextRun()` and in the IPC `schedule_task` handler. The `tz` option causes the parser to evaluate the cron expression in the given timezone, handling DST transitions correctly.

**Alternatives considered**:
- Manual UTC offset arithmetic: Rejected. Error-prone with DST. The library handles this correctly.
- Storing `next_run` as local time strings: Rejected. ISO 8601 UTC strings are the existing convention and avoid ambiguity.

## R3: Rehydration Scope -- Which Tasks to Correct

**Decision**: Correct all cron tasks where `created_tz != TIMEZONE` and `status != 'completed'`. Skip interval tasks (relative, timezone-independent), once-type tasks (absolute timestamps), and completed tasks (will never fire again).

**Rationale**: Per spec clarifications, paused cron tasks must also be corrected because `resume_task` only sets `status: 'active'` without recomputing `next_run`. Completed tasks are excluded because they have no future execution.

**Alternatives considered**:
- Only correct active tasks: Rejected. Paused tasks would fire at wrong times when resumed.
- Recompute `next_run` for all task types: Rejected. Interval tasks use relative offsets (ms from last run), and once-type tasks use absolute timestamps -- neither depends on timezone.

## R4: Atomicity and Idempotency Strategy

**Decision**: Each task correction is a single `UPDATE scheduled_tasks SET next_run = ?, created_tz = ? WHERE id = ?` statement. No wrapping transaction across all tasks.

**Rationale**: Per spec, the operation must be idempotent. If the process crashes mid-rehydration, uncorrected tasks retain their old `created_tz` and will be corrected on the next startup. A single UPDATE per task ensures `next_run` and `created_tz` are always consistent (no intermediate state where one is updated but not the other).

**Alternatives considered**:
- Wrapping all corrections in a single transaction: Rejected per spec. Adds complexity without benefit since idempotency already handles partial failures.

## R5: Detection Mechanism -- `created_tz` vs Computed `next_run` Comparison

**Decision**: Detect drift by string comparison `created_tz == TIMEZONE`. Do NOT recompute and compare `next_run` values.

**Rationale**: Per spec clarification, this is the mandated approach. String comparison is simpler and avoids edge cases where a recomputed `next_run` might match the stored value by coincidence (e.g., a cron that fires at the same wall-clock time in different timezones).

**Alternatives considered**:
- Compare computed vs stored `next_run`: Rejected per spec. More complex and can produce false negatives.
