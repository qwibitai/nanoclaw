# NanoClaw System Architecture

Canonical architecture view for this NanoClaw codebase (including Jarvis extension).

Boundary ownership lives in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md). This file describes topology, not what layer owns each change.

## Layered Topology

1. **Host Orchestrator (NanoClaw core)**
   - Runtime: Node.js process
   - Files: `src/index.ts`, `src/group-queue.ts`, `src/ipc.ts`, `src/db.ts`, `src/container-runner.ts`, `src/runtime-ownership.ts`
   - Responsibilities: claim single-host runtime ownership, poll messages, route by group, queue execution, persist generic runtime state

2. **Jarvis Extension Layer**
   - Files: `src/extensions/jarvis/*`
   - Responsibilities: lane identity, Andy frontdesk semantics, dispatch authorization, request/linkage state transitions, synthetic worker JID compatibility, startup replay for Jarvis worker lanes

3. **Agent Runtime Tier**
   - `andy-bot`: `nanoclaw-agent` (observe/research lane)
   - `andy-developer`: `nanoclaw-agent` (dispatch/review lane)
   - `jarvis-worker-*`: `nanoclaw-worker` (bounded execution lane)

4. **Persistence + Control Plane**
   - SQLite for chat/task/session/run state
   - `runtime_owners` for single active host ownership and heartbeat tracking
   - `dispatch_attempts` for request-to-worker handoff auditability
   - Filesystem IPC per group under `data/ipc/<group>`
   - Contract lifecycle: `queued -> running -> review_requested|failed_contract|failed`

## Execution Boundaries

- Core orchestration remains in NanoClaw host files.
- Launchd `com.nanoclaw` is the default runtime owner; manual runs are an explicit override path.
- Jarvis policy belongs under `src/extensions/jarvis/*`, not as duplicated inline helper clusters in `src/index.ts`, `src/ipc.ts`, and `src/db.ts`.
- Worker behavior is contract-driven (dispatch/completion schema), not prompt-only.
- Non-worker groups retain Claude Agent SDK behavior.
- Jarvis worker runtime is isolated to `jarvis-worker-*` image routing and role policy.
- Internal lane identity is based on lane IDs; synthetic `@nanoclaw` JIDs remain adapter compatibility only.

## Delegation Model

- `main` can target any group.
- `andy-developer` can delegate only to `jarvis-worker-*`.
- `andy-bot` is observer/research only and does not dispatch worker tasks.

## Canonical State Split

- `andy_requests`: user-facing request lifecycle
- `dispatch_attempts`: each coordinator handoff attempt
- `worker_runs`: accepted worker execution runs

These are separate state machines. Blocked dispatch is not a worker run.

## Required Companion Docs

- `docs/architecture/nanoclaw-jarvis.md`
- `docs/workflow/nanoclaw-jarvis-dispatch-contract.md`
- `docs/workflow/nanoclaw-jarvis-worker-runtime.md`
- `docs/workflow/nanoclaw-jarvis-acceptance-checklist.md`
