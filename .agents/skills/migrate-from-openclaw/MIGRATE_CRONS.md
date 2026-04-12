# Migrating OpenClaw Cron Jobs to NanoClaw Scheduler Jobs

This file is referenced by SKILL.md Phase 5 when cron jobs are detected.

**Before inserting jobs:** Read `src/storage/db.ts` and search for `jobs` to verify the current table schema. The schema below is a reference — if columns have been added, removed, or renamed, use the current schema from the source code.

## OpenClaw Cron Job Format

Source: `<STATE_DIR>/cron/jobs.json` (from `src/cron/types.ts`). If the file format doesn't match what's described below, read the actual file and adapt — OpenClaw may have changed the schema.

The jobs file is `{ version: 1, jobs: CronJob[] }`. Each job has:
- `id`, `name`, `description`, `enabled`, `deleteAfterRun`
- `schedule`: `{ kind: "cron", expr: string, tz?: string }` | `{ kind: "every", everyMs: number }` | `{ kind: "at", at: string }`
- `payload`: `{ kind: "agentTurn", message: string, model?, thinking?, timeoutSeconds? }` | `{ kind: "systemEvent", text: string }`
- `sessionTarget`: `"main"` | `"isolated"` | `"current"` | `"session:<id>"`
- `wakeMode`: `"next-heartbeat"` | `"now"`
- `delivery`: `{ mode: "none" | "announce" | "webhook", channel?, to?, threadId?, bestEffort? }`
- `failureAlert`: `{ after?: number, channel?, to?, cooldownMs? }` | `false`
- `state`: runtime state (nextRunAtMs, lastRunStatus, consecutiveErrors, etc.)

## NanoClaw `jobs` Table

Source: `src/storage/db.ts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Unique job ID |
| `name` | TEXT | Human-readable job name |
| `prompt` | TEXT | Job instructions |
| `script` | TEXT | Optional bash pre-check script |
| `schedule_type` | TEXT | `"cron"`, `"interval"`, `"once"`, or `"manual"` |
| `schedule_value` | TEXT | Cron expr, ms interval, or ISO timestamp |
| `status` | TEXT | `"active"`, `"paused"`, `"running"`, `"completed"`, `"dead_lettered"` |
| `linked_sessions` | TEXT | JSON array of chat JIDs |
| `group_scope` | TEXT | Owning group folder |
| `created_by` | TEXT | `"agent"` or `"human"` |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO timestamp |
| `next_run` | TEXT | ISO timestamp — must be computed at insert time |
| `timeout_ms` | INTEGER | Execution timeout |
| `max_retries` | INTEGER | Retry ceiling |
| `retry_backoff_ms` | INTEGER | Retry backoff |
| `max_consecutive_failures` | INTEGER | Auto dead-letter threshold |
| `consecutive_failures` | INTEGER | Current failure streak |

## Field Mapping

- `schedule.kind:"cron"` + `schedule.expr` → `schedule_type:"cron"`, `schedule_value:<expr>`
- `schedule.kind:"every"` + `schedule.everyMs` → `schedule_type:"interval"`, `schedule_value:<ms as string>`
- `schedule.kind:"at"` + `schedule.at` → `schedule_type:"once"`, `schedule_value:<ISO timestamp>`
- `payload.message` or `payload.text` → `prompt`
- `sessionTarget`/delivery destination → `linked_sessions:[<chat_jid>]`
- mapped target group folder → `group_scope`

## What Doesn't Map

- `delivery.mode:"webhook"` — NanoClaw has no webhook delivery. Discuss with the user: this could be implemented as a task `script` that runs `curl` to hit the webhook endpoint.
- `failureAlert` — NanoClaw has no failure alert system. Note this to the user.
- `wakeMode` — NanoClaw jobs always wake the agent when due.
- `payload.model`, `payload.thinking`, `payload.timeoutSeconds` — NanoClaw doesn't support per-task model/thinking config. These are handled by the SDK.
- `deleteAfterRun` — NanoClaw `"once"` jobs are marked `"completed"` after running, not deleted.

## For Each Enabled Job

1. Show what it does: name, schedule, prompt, delivery mode
2. Explain any differences (no retry config, no webhook delivery, no failure alerts)
3. If `delivery.mode:"webhook"`: discuss with the user — a task `script` with `curl` often suffices
4. Ask if they want to keep this job

## Inserting Jobs

Insert directly into the SQLite database. This requires groups to be registered first (Phase 1). Use the registered group's `folder` and `chat_jid`:

```bash
npx tsx -e "
const Database = require('better-sqlite3');
const { CronExpressionParser } = require('cron-parser');
const db = new Database('store/messages.db');
// Compute next_run for cron tasks:
// const interval = CronExpressionParser.parse('<expr>', { tz: process.env.TZ || 'UTC' });
// const nextRun = interval.next().toISOString();
db.prepare(\`INSERT INTO jobs (id, name, prompt, script, schedule_type, schedule_value, status, linked_sessions, group_scope, created_by, created_at, updated_at, next_run, timeout_ms, max_retries, retry_backoff_ms, max_consecutive_failures, consecutive_failures) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\`).run(
  'migrated-<original-id>',
  '<job-name>',
  '<mapped prompt>',
  null,
  '<mapped schedule_type>',
  '<mapped schedule_value>',
  'active',
  JSON.stringify(['<chat_jid>']),
  '<group_folder>',
  'human',
  new Date().toISOString(),
  new Date().toISOString(),
  '<computed next_run ISO>',
  300000,
  3,
  5000,
  5,
  0
);
db.close();
"
```

**Computing `next_run`:**
- `cron` tasks: use `CronExpressionParser.parse(expr, { tz }).next().toISOString()`
- `interval` tasks: `new Date(Date.now() + ms).toISOString()`
- `once` jobs: `next_run` equals `schedule_value`

If groups haven't been registered yet (database doesn't exist), save the job details to `groups/main/openclaw-migration-jobs.md` with the exact SQL payloads, and tell the user: "These jobs will be created after `/setup` registers your groups."
