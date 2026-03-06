# NanoClaw Jarvis Architecture

## Intent

Jarvis extends NanoClaw with a worker execution tier while keeping NanoClaw core small and generic.

- Core host orchestration remains in `src/index.ts`, `src/container-runner.ts`, `src/group-queue.ts`, `src/ipc.ts`, `src/db.ts`.
- Workflow policy lives in docs/CLAUDE/skills, not in host-loop feature sprawl.
- Worker execution uses OpenCode free-model containers.

## Runtime Tiers

| Tier | Runtime | Role |
|------|---------|------|
| Main orchestration | NanoClaw Node.js process | Poll messages, route by group, enforce queueing and run-state updates |
| Andy-bot (observer) | `nanoclaw-agent` container | Monitor, summarize, triage, GitHub research on `openclaw-gurusharan`, hand off to Andy-developer |
| Andy-Developer (lead) | `nanoclaw-agent` container | Planning, dispatching, review, rework instructions |
| Jarvis worker (`jarvis-worker-*`) | `nanoclaw-worker` container | Bounded execution only (implement/fix/test/etc.) |

## Worker Routing

- Group folder prefix `jarvis-worker*` routes to `WORKER_CONTAINER_IMAGE` (`nanoclaw-worker:latest` by default).
- Explicit `containerConfig.image` is supported; worker-mode behavior is only auto-applied for `nanoclaw-worker` images.
- Non-worker groups keep Claude Agent SDK session behavior unchanged.

## Delegation Authorization

- `main` can target any group (existing NanoClaw control plane behavior).
- `andy-developer` can delegate only to `jarvis-worker-*` targets through IPC message/task lanes.
- `andy-bot` is observer/research only and does not dispatch worker tasks.
- Other non-main groups remain self-scoped (no cross-group delegation).

## Canonical Run Lifecycle

```text
queued -> running -> review_requested
               -> failed_contract
               -> failed
```

- `run_id` is canonical and must be provided by dispatcher.
- Same `run_id` is idempotent: duplicate execution is blocked unless retrying from `failed`/`failed_contract`.
- Completion contract gates transition to `review_requested`.

## Invariants (P0)

1. No plain-text worker dispatch. Worker dispatch must be strict JSON.
2. Required dispatch fields: `run_id`, `task_type`, `context_intent`, `input`, `repo`, `branch`, `acceptance_tests`, `output_contract`.
3. Branch must follow `jarvis-<feature>`.
4. Session intent policy is enforced:
   - `fresh` dispatches must not include `session_id`.
   - `continue` dispatches must include `session_id` in `output_contract.required_fields`.
   - explicit cross-worker `session_id` reuse is blocked.
5. Completion block must include `run_id`, `branch`, `commit_sha`, `files_changed`, `test_result`, `risk`, and one of `pr_url` or `pr_skipped_reason`.
6. Completion `run_id` must match dispatch `run_id`.

## Storage and Auditability

`worker_runs` tracks:

- run state (`queued/running/review_requested/failed_contract/failed/done`)
- retry count
- completion artifacts (`branch_name`, `commit_sha`, `files_changed`, `test_summary`, `risk_summary`, `pr_url`)
- dispatch/session lineage (`dispatch_repo`, `dispatch_branch`, `context_intent`, `parent_run_id`)
- session continuity telemetry (`dispatch_session_id`, `selected_session_id`, `effective_session_id`, `session_selection_source`, `session_resume_status`, `session_resume_error`)
- real-time progress (`last_progress_summary`, `last_progress_at`, `steer_count`)

`worker_steering_events` tracks each steer request (`steer_id`, `run_id`, `message`, `sent_at`, `acked_at`, `status`).

This keeps worker runs reproducible, review-auditable, and steerable in-flight.

## Bidirectional Worker Communication

Workers emit progress events to `data/ipc/{folder}/progress/{run_id}/` (polled by host every 2s, forwarded to andy-developer as `[run-id] ↻ {summary}`).

Andy-developer can steer an in-flight worker by writing a `steer_worker` IPC task. The host writes a steer event to `data/ipc/{folder}/steer/{run_id}.json`; the worker polls and injects it as a follow-up user turn within 500ms. See `groups/andy-developer/docs/worker-steering.md`.

## Policy Placement

| Concern | Location |
|---------|----------|
| Host primitives | `src/*` core files |
| Dispatch contract | `src/dispatch-validator.ts` + `docs/workflow/nanoclaw-jarvis-dispatch-contract.md` |
| Worker runtime details | `docs/workflow/nanoclaw-jarvis-worker-runtime.md` |
| Team operating model | `docs/operations/workflow-setup-responsibility-map.md` + lane `groups/*/CLAUDE.md` |

## Non-Goals

- No HTTP microservice worker API.
- No replacement of NanoClaw host loop with workflow-specific logic.
- No ad-hoc per-group behavior outside the contract + policy docs.
