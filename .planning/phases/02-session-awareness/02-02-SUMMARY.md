---
phase: 02-session-awareness
plan: 02
subsystem: session-awareness
tags: [ipc, concurrency, container-startup, prompt-injection]
dependency_graph:
  requires: [session-awareness-writer, container-input]
  provides: [session-awareness-reader, prompt-awareness-injection]
  affects: [container/agent-runner]
tech_stack:
  added: []
  patterns: [xml-context-block, defensive-file-reading, self-filtering]
key_files:
  created: []
  modified:
    - container/agent-runner/src/index.ts
    - src/container-runner.ts
    - src/index.ts
    - src/task-scheduler.ts
decisions:
  - "containerId added to ContainerInput interface — container needs it to filter self from active sessions list"
  - "Session awareness read once on startup, not per query — point-in-time snapshot is sufficient"
  - "XML <active-sessions> block prepended to prompt — matches existing Claude context block convention"
  - "Empty string returned on missing/corrupt/empty file — no exceptions, no noise"
  - "Self-filtering uses ownContainerId param — graceful fallback when containerId absent (shows all sessions)"
metrics:
  duration: 170s
  completed: 2026-03-11T21:08:27Z
  tasks: 1
  files_created: 0
  files_modified: 4
---

# Phase 02 Plan 02: Container-Side Session Awareness Summary

Container reads `/workspace/ipc/active_sessions.json` on startup, filters out self, formats as `<active-sessions>` XML block, and prepends to initial prompt for agent coordination.

## What Was Built

### Session Awareness Reader (`container/agent-runner/src/index.ts`)

New `readSessionAwareness(ownContainerId?)` function that:

- Reads `/workspace/ipc/active_sessions.json` (written by host-side session-awareness module from 02-01)
- Parses JSON and validates `sessions` array exists and is non-empty
- Filters out the container's own entry using `ownContainerId`
- Formats remaining sessions as an `<active-sessions>` XML block
- Returns empty string on missing, corrupt, empty, or self-only files

### Prompt Injection (`container/agent-runner/src/index.ts`)

In `main()`, after building the initial prompt (scheduled task prefix + IPC drain), the awareness context is prepended:

```
<active-sessions>
  <session containerId="pm-agent-1741689000-1" started="2026-03-11T10:30:00Z" type="message" />
</active-sessions>

[Original prompt follows]
```

This runs once on startup — the agent gets a point-in-time snapshot of other active containers.

### ContainerId Threading (Deviation — Rule 3)

`containerId` was not part of the `ContainerInput` interface passed from host to container. Added it to:

- **`src/container-runner.ts`** — host-side `ContainerInput` interface
- **`src/index.ts`** — `runAgent()` now passes `containerId` in the input object
- **`src/task-scheduler.ts`** — `runTask()` now passes `containerId` in the input object
- **`container/agent-runner/src/index.ts`** — container-side `ContainerInput` interface

This was necessary for the container to filter itself out of the active sessions list.

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| File missing | Returns `''` — no crash, no log |
| File empty | Returns `''` — no crash, no log |
| Invalid JSON | Returns `''` — logs error |
| Missing `sessions` array | Returns `''` — no crash |
| Empty `sessions` array | Returns `''` — no crash |
| Only self in sessions | Returns `''` — self filtered out |
| No `containerId` provided | Shows all sessions (no filtering) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added containerId to ContainerInput interface**
- **Found during:** Task 1
- **Issue:** Plan states "The container knows its own containerId from ContainerInput" but ContainerInput did not include containerId — it was only available on the host side
- **Fix:** Added `containerId?: string` to both host-side and container-side `ContainerInput` interfaces, threaded it through `runAgent()` and `runTask()` calls
- **Files modified:** `src/container-runner.ts`, `src/index.ts`, `src/task-scheduler.ts`, `container/agent-runner/src/index.ts`
- **Commit:** `2a6f310`

## Commits

| # | Hash | Message |
|---|------|---------|
| 1 | `2a6f310` | feat(02-02): add session awareness reading and prompt injection in container |

## Self-Check: PASSED

- [x] `container/agent-runner/src/index.ts` — FOUND (readSessionAwareness function + call site)
- [x] `02-02-SUMMARY.md` — FOUND
- [x] Commit `2a6f310` — FOUND
- [x] Build: clean (no type errors)
- [x] Tests: 382/382 passing (all existing, zero regressions)
