# NanoClaw-Jarvis Acceptance Contract

Use this contract before marking NanoClaw-Jarvis integration changes complete.

This document defines required outcomes.
Evidence must be produced by executable gates, not static checkbox edits.

## 1) Architecture Boundaries (Must Hold)

1. NanoClaw host loop remains orchestrator (`src/index.ts`, `src/container-runner.ts`, `src/group-queue.ts`, `src/ipc.ts`, `src/db.ts`).
2. No worker HTTP microservice is introduced.
3. Non-worker groups keep existing Claude Agent SDK behavior.
4. Role split remains explicit: `Andy-bot` (observe/research), `Andy-developer` (dispatch/review), `jarvis-worker-*` (bounded execution).

## 2) Dispatch/Completion Contract (Must Hold)

1. Worker dispatch is strict JSON.
2. Plain-text worker dispatch is rejected.
3. `run_id` is canonical and caller-provided.
4. Duplicate `run_id` does not double execute.
5. Retry semantics are bounded to `failed` and `failed_contract`.
6. Completion artifacts satisfy required fields and `run_id`/branch matching.

Reference: `docs/workflow/nanoclaw-jarvis-dispatch-contract.md`.

## 3) Worker Runtime Contract (Must Hold)

1. Worker lanes use `nanoclaw-worker:latest` (unless explicitly overridden).
2. Worker secret scope remains role-bounded.
3. Worker skills/rules staging is deterministic and read-only in-container.
4. Timeout/probe guardrails remain deterministic.

Reference: `docs/workflow/nanoclaw-jarvis-worker-runtime.md`.

## 4) Executable Verification Gate (Required)

Run:

```bash
bash scripts/jarvis-ops.sh acceptance-gate
```

For Andy user-facing reliability/sign-off changes:

```bash
bash scripts/jarvis-ops.sh acceptance-gate --include-happiness --happiness-user-confirmation "<manual User POV runbook completed>"
```

## 5) Evidence Requirements (Required)

Acceptance evidence must include the generated manifest:

- `data/diagnostics/acceptance/acceptance-<timestamp>.json`

And, when relevant, supporting incident artifacts:

- `bash scripts/jarvis-ops.sh incident-bundle --window-minutes 180 --lane andy-developer [--incident-id <id>]`

## 6) Exit Criteria

A change is complete only when:

1. Acceptance gate summary status is `pass`.
2. Contract/runtime/docs updates are synchronized in the same change set.
3. Any linked incident is updated with verification and next action/resolution state.

## Agent Routing

| Step | Agent | Mode | Notes |
|------|-------|------|-------|
| Pass/fail judgment | opus | — | Final acceptance decision stays with Opus |
| Full gate sequence | verifier | bg | Run all acceptance gates in background |
| Evidence collection | scout | fg | Gather pre-gate artifacts and state |
