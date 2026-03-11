---
phase: 01-multi-container-groupqueue
plan: 02
subsystem: index, task-scheduler
tags: [concurrency, session-management, containerId-flow]
dependency_graph:
  requires: [01-01]
  provides: [multi-container-callers, fresh-session-per-container, per-container-idle-timeout]
  affects: [group-queue.test.ts]
tech_stack:
  added: []
  patterns: [fresh-session-per-container, per-container-idle-timeout, containerId-threading]
key_files:
  created: []
  modified: [src/index.ts, src/task-scheduler.ts, src/group-queue.ts]
decisions:
  - Fresh session per container (sessionId=undefined) for CONC-02 — idle-reuse containers already have their session internally
  - Task session logic preserved — context_mode 'group' still resumes group session, 'isolated' still fresh
  - QueuedTask.fn signature changed to receive containerId from GroupQueue.runTask
  - Single atomic commit for tightly coupled cross-file changes
metrics:
  duration: 268s
  completed: 2026-03-11T20:51:27Z
---

# Phase 01 Plan 02: Update Callers for Multi-Container API Summary

Thread containerId through index.ts and task-scheduler.ts for multi-container GroupQueue, with fresh Claude sessions per new container (CONC-02) and per-container idle timeouts (CONC-03).

## What Changed

### index.ts — processGroupMessages

The `processGroupMessages` callback now receives `containerId` from GroupQueue's `runForGroup`:

```typescript
async function processGroupMessages(chatJid: string, containerId: string): Promise<boolean>
```

All GroupQueue calls within this function now target the specific container:
- `queue.closeStdin(chatJid, containerId)` — idle timeout closes THIS container only
- `queue.notifyIdle(chatJid, containerId)` — marks THIS container as idle
- `queue.registerProcess(chatJid, proc, containerName, group.folder, containerId)` — registers against THIS slot

### index.ts — runAgent (CONC-02: Fresh Sessions)

The `runAgent` function now accepts `containerId` and passes `sessionId: undefined` to `runContainerAgent`. This ensures every new container gets a fresh Claude session:

```typescript
// CONC-02: Fresh session per container. New containers always start a fresh
// Claude session. Idle-reuse containers already have their session internally.
const sessionId = undefined;
```

The `newSessionId` saving logic is preserved — the last container to return a `newSessionId` becomes the group default. This only matters for idle-reuse (where the container already has its session internally).

### index.ts — Idle Timeout (CONC-03)

The idle timer now targets the specific container that's idle, rather than the first container for the group:

```typescript
queue.closeStdin(chatJid, containerId); // close THIS container, not all
```

### task-scheduler.ts — SchedulerDependencies

The `onProcess` callback now includes `containerId`:

```typescript
onProcess: (
  groupJid: string,
  proc: ChildProcess,
  containerName: string,
  groupFolder: string,
  containerId: string,
) => void;
```

### task-scheduler.ts — runTask

Task execution now receives `containerId` from `GroupQueue.runTask` and threads it through:
- `deps.onProcess(task.chat_jid, proc, containerName, task.group_folder, containerId)`
- `deps.queue.notifyIdle(task.chat_jid, containerId)`
- `deps.queue.closeStdin(task.chat_jid, containerId)`

Task session logic preserved: `context_mode: 'group'` still resumes the group session, `context_mode: 'isolated'` still gets fresh. This is intentional — CONC-02 applies to message containers.

### group-queue.ts — QueuedTask.fn Signature

The `QueuedTask.fn` callback was updated to receive `containerId`:

```typescript
fn: (containerId: string) => Promise<void>
```

`GroupQueue.runTask` now passes `containerId` to `task.fn(containerId)`, completing the flow from GroupQueue internals to external callers.

## Verification

- `npx tsc --noEmit` — **0 errors** (full project compiles cleanly)
- `npm run build` — **passes cleanly**
- `npx vitest run` — **371/371 tests pass** (all tests pass, including GroupQueue tests)
- No changes to container-runner.ts or volume mount logic (COMPAT-02 satisfied)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Single commit for tightly coupled changes**
- **Found during:** Task 1 / Task 2 boundary
- **Issue:** index.ts and task-scheduler.ts changes are interdependent — the `startSchedulerLoop` call in index.ts uses `SchedulerDependencies.onProcess` from task-scheduler.ts. Neither file compiles without the other's changes.
- **Fix:** Committed all three files atomically instead of per-task commits
- **Files modified:** src/index.ts, src/task-scheduler.ts, src/group-queue.ts
- **Commit:** `da0ff6a`

**2. [Rule 2 - Missing functionality] QueuedTask.fn containerId parameter**
- **Found during:** Task 2
- **Issue:** Plan noted that `QueuedTask.fn` needed updating to `(containerId: string) => Promise<void>` and `runTask` needed to pass `containerId` to `task.fn()`. Plan 01-01 left this as `() => Promise<void>`.
- **Fix:** Updated `QueuedTask` interface and `enqueueTask` signature in group-queue.ts, and `runTask` to call `task.fn(containerId)`
- **Files modified:** src/group-queue.ts
- **Commit:** `da0ff6a`

## Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1+2 | Thread containerId through callers for multi-container support | `da0ff6a` | src/index.ts, src/task-scheduler.ts, src/group-queue.ts |

## Self-Check: PASSED

All files exist, all commits verified, all key patterns present in source.
