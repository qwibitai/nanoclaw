# NanoClaw System Architecture

Canonical architecture view for this NanoClaw codebase (including Jarvis extension).

## Layered Topology

1. **Host Orchestrator (NanoClaw core)**
   - Runtime: Node.js process
   - Files: `src/index.ts`, `src/group-queue.ts`, `src/ipc.ts`, `src/db.ts`, `src/container-runner.ts`
   - Responsibilities: poll messages, route by group, queue execution, enforce contracts, persist run state

2. **Agent Runtime Tier**
   - `andy-bot`: `nanoclaw-agent` (observe/research lane)
   - `andy-developer`: `nanoclaw-agent` (dispatch/review lane)
   - `jarvis-worker-*`: `nanoclaw-worker` (bounded execution lane)

3. **Persistence + Control Plane**
   - SQLite for chat/task/session/run state
   - Filesystem IPC per group under `data/ipc/<group>`
   - Contract lifecycle: `queued -> running -> review_requested|failed_contract|failed`

## Execution Boundaries

- Core orchestration remains in NanoClaw host files.
- Worker behavior is contract-driven (dispatch/completion schema), not prompt-only.
- Non-worker groups retain Claude Agent SDK behavior.
- Jarvis worker runtime is isolated to `jarvis-worker-*` image routing and role policy.

## Delegation Model

- `main` can target any group.
- `andy-developer` can delegate only to `jarvis-worker-*`.
- `andy-bot` is observer/research only and does not dispatch worker tasks.

## Required Companion Docs

- `docs/architecture/nanoclaw-jarvis.md`
- `docs/workflow/nanoclaw-jarvis-dispatch-contract.md`
- `docs/workflow/nanoclaw-jarvis-worker-runtime.md`
- `docs/workflow/nanoclaw-jarvis-acceptance-checklist.md`
