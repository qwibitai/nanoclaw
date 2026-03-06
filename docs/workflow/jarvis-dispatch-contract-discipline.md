# Jarvis Dispatch Contract Discipline

Applies when changing worker dispatch flow, worker CLAUDE docs, or `src/dispatch-validator.ts`.

## Non-Negotiables

1. Worker dispatch must be strict JSON (no plain-text fallback).
2. `run_id` is caller-provided and canonical for retries/audit.
3. Dispatch requires: `run_id`, `request_id`, `task_type`, `input`, `repo`, `branch`, `acceptance_tests`, `output_contract`.
4. Completion requires: `run_id`, `branch`, `commit_sha`, `files_changed`, `test_result`, `risk`, and `pr_url|pr_skipped_reason`.
5. Completion `run_id` must match dispatch `run_id`.

## Edit Protocol

When contract fields change:

1. Update `src/dispatch-validator.ts`
2. Update caller/consumer behavior in `src/index.ts`
3. Update persistence fields in `src/db.ts` (if artifact set changed)
4. Update tests in `src/jarvis-worker-dispatch.test.ts`
5. Update docs: `docs/workflow/nanoclaw-jarvis-dispatch-contract.md`

Do not update only one layer.

## Verification

Run:

- `npm run build`
- `npm test`

before considering contract changes complete.
