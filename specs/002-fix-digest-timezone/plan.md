# Implementation Plan: Fix Duplicate Daily Digests (Timezone Drift)

**Branch**: `002-fix-digest-timezone` | **Date**: 2026-03-17 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/002-fix-digest-timezone/spec.md`

## Summary

Cron tasks created under UTC retain stale `next_run` values after a restart with the correct timezone, causing duplicate firings. The fix adds a `created_tz` column to `scheduled_tasks`, backfills it as `'UTC'`, and rehydrates all active/paused cron tasks on startup by recomputing `next_run` when `created_tz` differs from the current `TIMEZONE`. Interval and once-type tasks are skipped. Each correction is an atomic, idempotent single-UPDATE-per-task operation.

## Technical Context

**Language/Version**: TypeScript 5.x (Node.js, ESM)
**Primary Dependencies**: cron-parser 5.x, better-sqlite3, pino (logging)
**Storage**: SQLite via better-sqlite3 (`store/messages.db`)
**Testing**: Vitest (in-memory SQLite via `_initTestDatabase`)
**Target Platform**: macOS / Linux server (Node.js >= 20)
**Project Type**: Background service (single-process daemon)
**Performance Goals**: Rehydration adds < 100ms for < 100 tasks
**Constraints**: Single-process, synchronous SQLite, no external API calls during rehydration

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Readability First | PASS | Small, focused functions with descriptive names |
| II. Functional Design | PASS | `rehydrateTaskTimezones` is a pure-logic function that takes tasks + timezone and returns corrections; DB writes are separate |
| III. Maintainability Over Cleverness | PASS | Straightforward column addition + startup loop; no clever optimizations |
| IV. Best Practices | PASS | Follows existing migration pattern (ALTER TABLE + try/catch), existing test patterns (in-memory DB), existing cron-parser usage |
| V. Simplicity (KISS & YAGNI) | PASS | Minimal change: one column, one startup function, one IPC tweak |
| Test-First Development | PASS | Tests written before implementation per constitution |
| Quality Gates | PASS | All tests, lint, and typecheck must pass |

**Post-Design Re-check**: PASS. No new principles violated. The data model adds one column with a default. No new dependencies. No architectural changes.

## Project Structure

### Documentation (this feature)

```text
specs/002-fix-digest-timezone/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── config.ts            # TIMEZONE export (no changes needed)
├── db.ts                # Migration: add created_tz column; new getCronTasksForRehydration()
├── ipc.ts               # Pass TIMEZONE as created_tz in schedule_task handler
├── task-scheduler.ts    # New rehydrateTaskTimezones() function
├── types.ts             # Add created_tz to ScheduledTask interface
├── task-scheduler.test.ts  # New rehydration tests
└── logger.ts            # Used for correction logging (no changes needed)
```

**Structure Decision**: Single project structure. All changes are in the existing `src/` directory. No new directories needed. This is a bug fix touching 4 existing files and their tests.

## Complexity Tracking

No constitution violations. No complexity justifications needed.
