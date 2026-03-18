# Feature Specification: Fix Duplicate Daily Digests (Timezone Drift)

**Feature Branch**: `002-fix-digest-timezone`
**Created**: 2026-03-17
**Status**: Draft
**Input**: User description: "Fix duplicate daily digests caused by timezone drift in cron scheduler. The cron task `0 9 * * *` was created when NanoClaw interpreted time as UTC (9am UTC = 4am Central). After restart with correct timezone, it fires again at 9am Central. Both triggers ran during the overlap."

## Clarifications

### Session 2026-03-17

- Q: What happens if rehydration fails partway through (e.g., after correcting some tasks but not all)? Should corrections be transactional or idempotent? → A: Per-task idempotent — each task's `next_run` and `created_tz` are updated atomically (single UPDATE statement per task). No wrapping transaction needed. If the process crashes mid-rehydration, uncorrected tasks retain their old `created_tz` and will be corrected on the next startup. The update order within each task MUST be: update both `next_run` and `created_tz` in a single UPDATE statement to prevent inconsistent intermediate state.
- Q: How does rehydration determine whether a cron task's `next_run` is "already correct" — by comparing the `next_run` value or by checking `created_tz`? → A: By `created_tz == TIMEZONE` string comparison. The system does NOT recompute and compare `next_run` values. If `created_tz` matches the current `TIMEZONE`, the task is skipped entirely regardless of its `next_run` value.
- Q: Should rehydration correct paused cron tasks in addition to active ones? → A: Yes. Paused cron tasks with stale `created_tz` must also have their `next_run` and `created_tz` corrected during rehydration. The `resume_task` IPC handler only sets `status: 'active'` without recomputing `next_run`, so a paused task resumed after a timezone change would fire at the wrong time if not corrected. Completed tasks are excluded (they will not fire again).

## Assumptions

- **A1**: The root cause is timezone drift — the task's `created_at` timestamp and initial `next_run` were computed under UTC because the `TZ` environment variable was not set when the task was first registered. After a restart with the correct timezone (e.g., `America/Chicago`), the same `0 9 * * *` cron now evaluates to 9am Central, causing both the stale UTC-based fire (4am Central) and the correct fire (9am Central) on the same day.
- **A2**: The `daily-digest-prep.sh` script is invoked by an external scheduler (launchd or host cron) and does NOT itself send messages — it only writes data files for the container agent to read. It is not a source of duplicate sends.
- **A3**: The fix should be backward-compatible. Existing tasks with correctly-computed `next_run` values should not be disrupted.
- **A4**: The TIMEZONE config value (`src/config.ts`) correctly resolves to the user's local timezone when `TZ` is set or via `Intl.DateTimeFormat().resolvedOptions().timeZone`. The issue is that tasks created under a different timezone assumption have stale `next_run` values.
- **A5**: There is only one daily-digest task in the database. No duplicate task rows exist.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Timezone-Aware Task Rehydration on Startup (Priority: P1)

When NanoClaw starts, it should detect and correct any scheduled tasks whose `next_run` values are inconsistent with the current timezone configuration. This prevents duplicate or mistimed task executions caused by timezone drift between restarts.

**Why this priority**: This is the direct fix for the reported duplicate digest issue. Without it, every restart under a different timezone assumption can cause duplicate or missed task executions.

**Independent Test**: Can be tested by creating a task with a `next_run` computed under UTC, then starting the scheduler under `America/Chicago` and verifying the `next_run` is recomputed to match the current timezone.

**Acceptance Scenarios**:

1. **Given** a cron task `0 9 * * *` with `next_run` computed under UTC (e.g., `2026-03-18T09:00:00.000Z`), **When** NanoClaw starts with `TIMEZONE=America/Chicago`, **Then** the task's `next_run` is recomputed using the cron expression evaluated in `America/Chicago`, yielding `2026-03-18T14:00:00.000Z` (9am Central = 2pm UTC during CDT).
2. **Given** a cron task `0 9 * * *` whose `created_tz` already matches the current `TIMEZONE` (e.g., both `America/Chicago`), **When** NanoClaw starts, **Then** the task's `next_run` is unchanged (no unnecessary writes). Detection is by `created_tz == TIMEZONE` string comparison, NOT by comparing the computed `next_run` value.
3. **Given** an interval task (not cron), **When** NanoClaw starts, **Then** the task's `next_run` is not modified (interval tasks are relative, not timezone-dependent).
4. **Given** a paused cron task `0 9 * * *` with `created_tz = 'UTC'`, **When** NanoClaw starts with `TIMEZONE=America/Chicago`, **Then** the task's `next_run` and `created_tz` are corrected (same as active tasks). This ensures that when the task is later resumed, it fires at the correct local time without requiring `resume_task` to recompute `next_run`.

---

### User Story 2 - Store Timezone with Scheduled Tasks (Priority: P2)

When a scheduled task is created, the timezone in effect at creation time should be persisted alongside the task. This enables detection of timezone drift and makes task behavior auditable.

**Why this priority**: Storing the timezone at creation time provides the data needed for drift detection. Without it, the system cannot distinguish between "task was always meant for 9am UTC" and "task was created under UTC by accident."

**Independent Test**: Can be tested by creating a task via IPC and verifying the `created_tz` column is populated with the current `TIMEZONE` value.

**Acceptance Scenarios**:

1. **Given** a new task is created via IPC, **When** the `schedule_task` handler runs, **Then** the task row includes a `created_tz` field set to the current `TIMEZONE` value.
2. **Given** an existing task without a `created_tz` value (pre-migration), **When** the database migration runs, **Then** the `created_tz` is backfilled with `'UTC'` (conservative assumption — these are the tasks most likely affected by drift).

---

### User Story 3 - Startup Validation Log (Priority: P3)

When NanoClaw starts and rehydrates tasks, it should log any timezone corrections applied so the operator can audit what changed and why.

**Why this priority**: Observability is important for debugging, but the system works correctly without it. This is a quality-of-life improvement.

**Independent Test**: Can be tested by checking log output after startup with a drifted task — the log should contain the task ID, old `next_run`, new `next_run`, and the timezone change.

**Acceptance Scenarios**:

1. **Given** a cron task whose `next_run` was corrected during startup, **When** the rehydration runs, **Then** a log entry at `info` level is emitted with `taskId`, `oldNextRun`, `newNextRun`, `oldTz`, and `newTz`.
2. **Given** no tasks require correction, **When** the rehydration runs, **Then** no correction log entries are emitted (only a summary like "0 tasks corrected").

---

### Edge Cases

- What happens when the system timezone changes between two restarts (e.g., UTC -> America/Chicago -> America/New_York)? The rehydration should always recompute against the *current* timezone, regardless of how many changes occurred.
- What happens when a task's cron expression is invalid at rehydration time? The task should be logged as an error and skipped (not paused or deleted), preserving the existing error handling in `computeNextRun`.
- What happens when a `once` task has a stale `next_run`? Once-tasks use absolute timestamps and are not timezone-dependent — they should be skipped during rehydration.
- What happens during DST transitions? The `cron-parser` library with `tz` option handles DST correctly. The rehydration just needs to call it with the current timezone.
- What happens if `TIMEZONE` is explicitly set to `UTC` and the task was created under `UTC`? No correction should occur — `created_tz` matches current timezone.
- What happens if the process crashes during rehydration (partial failure)? Each task correction is idempotent — `next_run` and `created_tz` are updated in a single UPDATE statement per task. Uncorrected tasks retain their old `created_tz` and will be corrected on the next startup. No wrapping transaction is needed.
- What happens to paused cron tasks during rehydration? Paused cron tasks with stale `created_tz` are corrected (both `next_run` and `created_tz` updated) just like active tasks. This is necessary because `resume_task` only sets `status: 'active'` without recomputing `next_run`. Completed tasks are excluded since they will not fire again.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST recompute `next_run` for all active and paused cron tasks on startup when the task's `created_tz` differs from the current `TIMEZONE`. Completed tasks are excluded.
- **FR-002**: System MUST store the timezone (`created_tz`) used at task creation time in the `scheduled_tasks` table.
- **FR-003**: System MUST add a database migration that adds the `created_tz` column with a default of `'UTC'` for existing rows.
- **FR-004**: System MUST NOT modify `next_run` for interval or once-type tasks during startup rehydration (these are timezone-independent).
- **FR-005**: System MUST NOT modify `next_run` for cron tasks where `created_tz` already matches the current `TIMEZONE`.
- **FR-006**: System MUST update the task's `created_tz` to the current `TIMEZONE` after correcting `next_run`, so subsequent restarts do not re-correct.
- **FR-007**: System MUST log each timezone correction applied during startup, including task ID, old and new `next_run`, and timezone change.
- **FR-008**: The `computeNextRun` function MUST continue to use the current `TIMEZONE` for cron parsing (no behavioral change to existing runtime logic).
- **FR-009**: The IPC `schedule_task` handler MUST pass the current `TIMEZONE` as `created_tz` when creating new tasks.
- **FR-010**: Each task's `next_run` and `created_tz` MUST be updated in a single UPDATE statement during rehydration (atomic per-task correction). No wrapping transaction across all tasks is required — the operation is idempotent and self-corrects on subsequent startups if interrupted.

### Key Entities

- **ScheduledTask**: Extended with `created_tz: string` — the IANA timezone identifier (e.g., `America/Chicago`) under which the task was created. Used to detect drift on restart.
- **TIMEZONE** (config): The current system timezone, resolved from `TZ` env var or `Intl.DateTimeFormat`. Used as the reference for rehydration comparisons.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After the fix is deployed, a NanoClaw restart under a different timezone than when the task was created results in exactly ONE execution of the daily digest at the correct local time (no duplicate at the old UTC-derived time).
- **SC-002**: All existing cron tasks have their `next_run` corrected on first startup after deployment, verified by checking `next_run` values in the database match the cron expression evaluated in the current timezone.
- **SC-003**: New tasks created after deployment include a `created_tz` value matching the current `TIMEZONE`, verified by database inspection.
- **SC-004**: The rehydration process adds less than 100ms to startup time for databases with fewer than 100 scheduled tasks.
- **SC-005**: All existing tests continue to pass. New tests cover: (a) rehydration corrects drifted cron tasks, (b) rehydration skips interval/once tasks, (c) rehydration skips already-correct cron tasks, (d) `created_tz` is stored on new tasks, (e) rehydration corrects paused cron tasks with stale `created_tz`.
