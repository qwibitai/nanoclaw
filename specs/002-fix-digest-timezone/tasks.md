# Tasks: Fix Duplicate Daily Digests (Timezone Drift)

**Input**: Design documents from `/specs/002-fix-digest-timezone/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Required per spec (SC-005) and constitution (Test-First Development). Tests MUST be written before implementation.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Database migration and type system changes that all user stories depend on

- [x] T001 Add `created_tz: string` field to `ScheduledTask` interface in `src/types.ts`
- [x] T002 Add database migration for `created_tz` column with `DEFAULT 'UTC'` in `src/db.ts` `createSchema()` function, after the existing `context_mode` migration block

**Checkpoint**: Type system and database schema are updated. All existing tests still pass.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: New database accessor function and `updateTask` extension needed by multiple user stories

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Write test for `updateTaskTimezone(id, nextRun, createdTz)` in `src/db.test.ts` — verify atomic UPDATE of `next_run` and `created_tz` in a single statement
- [x] T004 Implement `updateTaskTimezone(id, nextRun, createdTz)` function in `src/db.ts` — single `UPDATE scheduled_tasks SET next_run = ?, created_tz = ? WHERE id = ?`
- [x] T005 Extend `updateTask()` in `src/db.ts` to accept `created_tz` in its `updates` parameter type (add to the `Pick<>` union)
- [x] T006 Extend `createTask()` in `src/db.ts` to include `created_tz` in the INSERT column list and values

**Checkpoint**: Foundation ready — all database functions support `created_tz`. User story implementation can begin.

---

## Phase 3: User Story 1 — Timezone-Aware Task Rehydration on Startup (Priority: P1) MVP

**Goal**: On startup, detect and correct cron tasks whose `next_run` values are inconsistent with the current timezone configuration. Prevents duplicate or mistimed task executions.

**Independent Test**: Create a task with `next_run` computed under UTC, then run rehydration under `America/Chicago` and verify `next_run` is recomputed to match the current timezone.

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T007 [P] [US1] Write test: rehydration corrects drifted cron task — create cron task `0 9 * * *` with `created_tz = 'UTC'`, run `rehydrateTaskTimezones('America/Chicago')`, verify `next_run` is recomputed with `America/Chicago` tz and `created_tz` is updated in `src/task-scheduler.test.ts`
- [x] T008 [P] [US1] Write test: rehydration skips cron task when `created_tz` matches current TIMEZONE — create cron task with `created_tz = 'America/Chicago'`, run `rehydrateTaskTimezones('America/Chicago')`, verify `next_run` is unchanged in `src/task-scheduler.test.ts`
- [x] T009 [P] [US1] Write test: rehydration skips interval tasks — create interval task with `created_tz = 'UTC'`, run `rehydrateTaskTimezones('America/Chicago')`, verify `next_run` is unchanged in `src/task-scheduler.test.ts`
- [x] T010 [P] [US1] Write test: rehydration skips once-type tasks — create once task with `created_tz = 'UTC'`, run `rehydrateTaskTimezones('America/Chicago')`, verify `next_run` is unchanged in `src/task-scheduler.test.ts`
- [x] T011 [P] [US1] Write test: rehydration corrects paused cron tasks — create paused cron task with `created_tz = 'UTC'`, run `rehydrateTaskTimezones('America/Chicago')`, verify both `next_run` and `created_tz` are corrected in `src/task-scheduler.test.ts`
- [x] T012 [P] [US1] Write test: rehydration skips completed cron tasks — create completed cron task with `created_tz = 'UTC'`, run `rehydrateTaskTimezones('America/Chicago')`, verify `next_run` is unchanged in `src/task-scheduler.test.ts`

### Implementation for User Story 1

- [ ] T013 [US1] Implement `rehydrateTaskTimezones(timezone: string)` function in `src/task-scheduler.ts` — query all cron tasks with `status IN ('active', 'paused')` where `created_tz != timezone`, recompute `next_run` using `CronExpressionParser.parse(schedule_value, { tz: timezone })`, and call `updateTaskTimezone()` for each correction
- [ ] T014 [US1] Add a new `getCronTasksForRehydration(timezone: string)` query function in `src/db.ts` — `SELECT * FROM scheduled_tasks WHERE schedule_type = 'cron' AND status IN ('active', 'paused') AND created_tz != ?`
- [ ] T015 [US1] Call `rehydrateTaskTimezones(TIMEZONE)` in `src/index.ts` during startup, after `initDatabase()` and `loadState()` but before `startSchedulerLoop()`

**Checkpoint**: Restart under a different timezone corrects stale `next_run` values. US1 acceptance scenarios 1-4 pass.

---

## Phase 4: User Story 2 — Store Timezone with Scheduled Tasks (Priority: P2)

**Goal**: When a scheduled task is created, persist the timezone in effect at creation time so drift can be detected on future restarts.

**Independent Test**: Create a task via IPC and verify the `created_tz` column is populated with the current `TIMEZONE` value.

### Tests for User Story 2

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T016 [P] [US2] Write test: new task created via IPC includes `created_tz` set to current TIMEZONE — call `processTaskIpc` with a `schedule_task` payload, read back the task row and verify `created_tz` matches `TIMEZONE` in `src/ipc-auth.test.ts`
- [ ] T017 [P] [US2] Write test: pre-migration rows have `created_tz = 'UTC'` — create a task without specifying `created_tz`, verify the database default is `'UTC'` in `src/db.test.ts`

### Implementation for User Story 2

- [ ] T018 [US2] Pass `TIMEZONE` as `created_tz` in the `schedule_task` handler in `src/ipc.ts` — add `created_tz: TIMEZONE` to the `createTask()` call at line ~263

**Checkpoint**: New tasks store `created_tz`. Existing tasks backfilled with `'UTC'`. US2 acceptance scenarios 1-2 pass.

---

## Phase 5: User Story 3 — Startup Validation Log (Priority: P3)

**Goal**: Log timezone corrections applied during startup so operators can audit what changed and why.

**Independent Test**: Check log output after startup with a drifted task — the log should contain taskId, oldNextRun, newNextRun, oldTz, newTz.

### Tests for User Story 3

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T019 [P] [US3] Write test: rehydration logs each correction with taskId, oldNextRun, newNextRun, oldTz, and newTz at info level in `src/task-scheduler.test.ts`
- [ ] T020 [P] [US3] Write test: rehydration emits summary log when 0 tasks corrected (no correction entries, only summary) in `src/task-scheduler.test.ts`

### Implementation for User Story 3

- [ ] T021 [US3] Add info-level log entry in `rehydrateTaskTimezones()` for each corrected task with `{ taskId, oldNextRun, newNextRun, oldTz, newTz }` in `src/task-scheduler.ts`
- [ ] T022 [US3] Add summary log at end of `rehydrateTaskTimezones()` with total corrected count in `src/task-scheduler.ts`

**Checkpoint**: Corrections are logged with full audit trail. US3 acceptance scenarios 1-2 pass.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Validation, cleanup, and edge case hardening

- [ ] T023 Run full test suite (`npm test`) — verify all existing and new tests pass
- [ ] T024 Run type checker (`npm run typecheck`) — verify zero type errors
- [ ] T025 Run linter — verify zero lint errors
- [ ] T026 Run build (`npm run build`) — verify clean compilation
- [ ] T027 Run quickstart.md validation: verify `created_tz` column exists in store/messages.db with correct default, and check startup logs for rehydration entries

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (types and migration must exist before DB functions)
- **User Story 1 (Phase 3)**: Depends on Phase 2 (needs `updateTaskTimezone()`, `getCronTasksForRehydration()`, and `createTask()` with `created_tz`)
- **User Story 2 (Phase 4)**: Depends on Phase 2 (needs `createTask()` with `created_tz` support)
- **User Story 3 (Phase 5)**: Depends on Phase 3 (logging is added to `rehydrateTaskTimezones()` which must exist first)
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) — no dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) — independent of US1, can run in parallel
- **User Story 3 (P3)**: Depends on US1 (adds logging to `rehydrateTaskTimezones()` which is created in US1)

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- DB query functions before business logic functions
- Business logic before startup integration
- Core implementation before integration wiring

### Parallel Opportunities

- **Phase 1**: T001 and T002 touch different files — can run in parallel
- **Phase 2**: T003-T006 are sequential (test before implementation), but T005 and T006 can run in parallel after T004
- **Phase 3 Tests**: T007-T012 all write to same test file but are independent test cases — write in batch
- **Phase 3 Impl**: T013 and T014 can run in parallel (different files), T015 depends on both
- **Phase 4 and Phase 3**: US2 (Phase 4) can start in parallel with US1 (Phase 3) since they touch different files (`src/ipc.ts` vs `src/task-scheduler.ts`)
- **Phase 5**: Depends on Phase 3 completion

---

## Parallel Example: User Story 1

```
# Write all US1 tests in parallel (same file, independent test cases):
Task T007: Test rehydration corrects drifted cron task
Task T008: Test rehydration skips already-correct cron task
Task T009: Test rehydration skips interval tasks
Task T010: Test rehydration skips once-type tasks
Task T011: Test rehydration corrects paused cron tasks
Task T012: Test rehydration skips completed cron tasks

# Implement DB query and business logic in parallel:
Task T013: Implement rehydrateTaskTimezones() in src/task-scheduler.ts
Task T014: Implement getCronTasksForRehydration() in src/db.ts

# Then wire into startup:
Task T015: Call rehydrateTaskTimezones(TIMEZONE) in src/index.ts
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (types + migration)
2. Complete Phase 2: Foundational (DB functions)
3. Complete Phase 3: User Story 1 (rehydration logic + tests)
4. **STOP and VALIDATE**: Run tests, verify drifted tasks are corrected on startup
5. Deploy if ready — this alone fixes the duplicate digest bug

### Incremental Delivery

1. Setup + Foundational -> Foundation ready
2. Add User Story 1 -> Test independently -> Deploy (MVP — fixes the bug)
3. Add User Story 2 -> Test independently -> Deploy (new tasks store timezone)
4. Add User Story 3 -> Test independently -> Deploy (audit logging)
5. Each story adds value without breaking previous stories

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Files changed: `src/types.ts`, `src/db.ts`, `src/task-scheduler.ts`, `src/ipc.ts`, `src/index.ts`, `src/task-scheduler.test.ts`, `src/db.test.ts`, `src/ipc-auth.test.ts`
