# NanoClaw-Jarvis Acceptance Checklist

Use this checklist before marking NanoClaw-Jarvis integration complete.

## Architecture Boundaries

- [x] NanoClaw host loop remains the orchestrator (`src/index.ts`, `src/container-runner.ts`, `src/group-queue.ts`, `src/ipc.ts`, `src/db.ts`).
- [x] No worker HTTP microservice introduced.
- [x] Non-worker groups keep existing Claude Agent SDK behavior.
- [x] Role split preserved: `Andy-bot` (observe/research) and `Andy-developer` (dispatch/review).

## Dispatch and State Contract

- [x] Worker dispatch requires strict JSON payload (`run_id`, `task_type`, `context_intent`, `input`, `repo`, `branch`, `acceptance_tests`, `output_contract`).
- [x] Plain-text worker dispatch is rejected.
- [x] `run_id` is canonical and required (no fallback hash generation).
- [x] Duplicate `run_id` does not double execute.
- [x] Retry semantics are bounded to `failed` and `failed_contract`.
- [x] Session intent enforcement works:
  - `context_intent=fresh` rejects provided `session_id`
  - `context_intent=continue` requires `session_id` in `output_contract.required_fields`
  - cross-worker explicit `session_id` reuse is blocked

## Completion Contract

- [x] `review_requested` requires valid `<completion>` JSON.
- [x] Completion requires `run_id`, `branch`, `commit_sha`, `files_changed`, `test_result`, `risk`, and `pr_url|pr_skipped_reason`.
- [x] Completion `run_id` must match dispatch `run_id`.
- [x] Completion artifacts are persisted in `worker_runs`.
- [x] Continue-mode runs require completion `session_id` when requested by dispatch contract.

## Worker Runtime Standardization

- [x] Worker groups route to OpenCode worker image (`nanoclaw-worker:latest` by default).
- [x] Worker secret scope is limited to `GITHUB_TOKEN`.
- [x] Worker git identity defaults to `openclaw-gurusharan` values.
- [x] Worker skills/rules are staged and mounted read-only for OpenCode.

## Documentation

- [x] `docs/architecture/nanoclaw-jarvis.md` updated as architecture source of truth.
- [x] `docs/workflow/nanoclaw-jarvis-dispatch-contract.md` added.
- [x] `docs/workflow/nanoclaw-jarvis-worker-runtime.md` added.
- [x] Root `CLAUDE.md` updated with compressed trigger-based docs index.

## Verification

- [x] `npm run build` passes.
- [x] `npm test` passes.
- [x] Live E2E dispatch to `jarvis-worker-1` with valid completion proof captured.
- [ ] Parallel live dispatch (`jarvis-worker-1` + `jarvis-worker-2`) proof captured.
- [x] Runtime validation with actual worker image rebuild completed (`container/worker/build.sh`).

### Evidence

- 2026-02-22: `npx tsx scripts/test-worker-e2e.ts` passed (`review_requested` persisted in `worker_runs`).

## Exit Criteria

Mark complete when all unchecked verification items are either passed or explicitly waived with rationale.
