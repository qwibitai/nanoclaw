---
title: "fix: Improve container error handling, logging, and scheduler resilience"
type: fix
status: completed
date: 2026-03-13
---

# Fix: Improve container error handling, logging, and scheduler resilience

## Overview

Three issues identified from log analysis of recent nanoclaw interactions:

1. **Silent message loss on container crash loops** — When containers fail repeatedly (e.g., TS compilation error), the user gets no notification. Messages are silently dropped after max retries.
2. **Idle timeout logged as ERROR** — Normal container cleanup after idle period triggers ERROR-level log, creating noise that obscures real problems.
3. **Scheduled task double-execution** — Tasks that take longer than `SCHEDULER_POLL_INTERVAL` (60s) can be re-queued while still running.

## Problem Analysis

### Issue 1: Silent failure on crash loops

On March 10, a breaking change in `@anthropic-ai/claude-agent-sdk` caused the agent-runner's TypeScript compilation to fail (exit code 2, ~1s per attempt). The retry loop in `group-queue.ts` ran 12+ attempts over two retry cycles without ever notifying the user. The `scheduleRetry()` function treats all errors identically — a transient network blip gets the same treatment as a deterministic compilation failure.

**Relevant code:**
- `src/group-queue.ts:255-276` — `scheduleRetry()` with blind exponential backoff
- `src/group-queue.ts:257-263` — Max retries exceeded, messages dropped silently
- `src/index.ts:224-241` — Error handling after agent run, cursor rollback

**Related known issue:** `docs/DEBUG_CHECKLIST.md` issue #3 documents cursor-before-execution. The cursor rollback on error (index.ts:235) handles this for retries, but when max retries are exceeded, the user never learns their message was lost.

### Issue 2: Idle timeout logged as ERROR

In `container-runner.ts:439`, the initial timeout trigger is always logged as `logger.error`. But when `hadStreamingOutput === true`, this is expected behavior — the agent already sent its response and the container is just being reaped after the idle period. The subsequent log at line 486 correctly logs this as INFO, but the initial ERROR at line 439 fires first, polluting error logs.

**Impact:** Every successful scheduled task and most interactive sessions generate a spurious ERROR entry, making it hard to spot real problems via `grep ERROR`.

### Issue 3: Scheduled task double-execution

The scheduler advances `next_run` before enqueuing (task-scheduler.ts:239-252), which prevents the *same* poll cycle from picking it up again. However, for cron schedules that fire frequently (e.g., every hour), if the task takes longer than `SCHEDULER_POLL_INTERVAL` (60s), the next poll finds the task due again because `next_run` was only advanced by one interval.

The `enqueueTask` duplicate check (group-queue.ts:93-97) only examines `pendingTasks`, not the currently running task. So a second copy gets queued while the first is active, leading to back-to-back execution.

**Observed:** March 11 10:00-10:01, task `task-1772994731598-1byoah` ran twice because the scheduler found it due at 10:01 while the first run (started at 10:00) was still active.

## Proposed Solution

### Fix 1: Notify user on max retries + short-circuit deterministic failures

**A. User notification on max retries** (`src/group-queue.ts`)

Add an `onMaxRetriesExceeded` callback to `GroupQueue` that the orchestrator (index.ts) binds to send a WhatsApp message to the user.

```
src/group-queue.ts — scheduleRetry():
  When retryCount > MAX_RETRIES:
    1. Call onMaxRetriesExceeded(groupJid, retryCount) callback
    2. Reset retryCount (existing behavior)
```

```
src/index.ts — setup:
  queue.onMaxRetriesExceeded = async (groupJid, retryCount) => {
    const channel = findChannel(channels, groupJid);
    if (channel) {
      await channel.sendMessage(groupJid,
        "I'm having trouble processing your message. I'll try again when you send your next message."
      );
    }
  };
```

**B. Short-circuit on deterministic failures** (`src/group-queue.ts` or `src/index.ts`)

Detect non-transient errors and skip retries. The `processGroupMessages` function (index.ts) currently returns `false` for all errors. Instead, have it return a richer signal:

```
src/index.ts — processGroupMessages():
  On container error with exit code 2 (compilation) or exit code 1 with
  TypeScript errors in stdout:
    Return 'permanent' instead of false

src/group-queue.ts — runForGroup():
  If processMessagesFn returns 'permanent':
    Skip scheduleRetry(), call onMaxRetriesExceeded() immediately
```

Implementation approach: Change `processMessagesFn` return type from `boolean` to `boolean | 'permanent'`. `true` = success, `false` = transient error (retry), `'permanent'` = deterministic failure (notify immediately).

**Files to modify:**
- `src/group-queue.ts` — Add callback, handle 'permanent' return
- `src/index.ts` — Bind callback, detect permanent failures from container output
- `src/group-queue.test.ts` — Test notification callback, permanent failure short-circuit

### Fix 2: Downgrade idle timeout log level

**Single-line change** in `container-runner.ts:439`:

Change `logger.error` to `logger.info` for the initial timeout trigger. The real error case ("timed out with no output") at line 500 stays as `logger.error`.

Before:
```typescript
logger.error(
  { group: group.name, containerName },
  'Container timeout, stopping gracefully',
);
```

After:
```typescript
logger.info(
  { group: group.name, containerName },
  'Container timeout, stopping gracefully',
);
```

**Files to modify:**
- `src/container-runner.ts:439` — Change log level
- `src/container-runner.test.ts` — Update any assertions on log level (if present)

### Fix 3: Prevent scheduled task double-execution

Add a `runningTaskIds` Set to `GroupQueue` that tracks currently executing task IDs. Check it in `enqueueTask` before adding to the queue.

```
src/group-queue.ts:
  private runningTaskIds = new Set<string>();

  enqueueTask():
    if (this.runningTaskIds.has(taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }

  runTask():
    this.runningTaskIds.add(task.id);  // in try block
    // ... existing logic ...
    finally:
      this.runningTaskIds.delete(task.id);  // in finally block
```

**Files to modify:**
- `src/group-queue.ts` — Add `runningTaskIds` Set, check in `enqueueTask`, manage in `runTask`
- `src/group-queue.test.ts` — Test that running tasks are not re-queued

## Acceptance Criteria

### Fix 1: User notification
- [x] When max retries are exceeded, a WhatsApp message is sent to the affected group
- [x] The message is plain text, does not include technical details
- [x] Deterministic failures (exit code 2 with TS errors) skip all retries and notify immediately
- [x] Existing retry behavior for transient errors is unchanged
- [x] Tests cover: notification callback fires on max retries, permanent failure short-circuits retries

### Fix 2: Log level
- [x] Container idle cleanup (timeout after output) no longer appears in ERROR grep
- [x] Container timeout with no output still logs as ERROR
- [x] Existing tests pass

### Fix 3: Double-execution prevention
- [x] A task that is currently running cannot be re-queued via `enqueueTask`
- [x] The `runningTaskIds` set is always cleaned up in the `finally` block
- [x] Tests cover: running task is skipped by enqueueTask, cleanup happens on error

## Advice on Issue 5: SDK Version Pinning

The crash loop was triggered by `@anthropic-ai/claude-agent-sdk: ^0.2.34` in `container/agent-runner/package.json`. The `^` allows any `0.2.x` patch, but pre-1.0 semver treats minor bumps as potentially breaking.

**Recommendation: Don't pin exact versions.** Here's why:

The SDK is pre-1.0 and evolving rapidly. Pinning to an exact version means you'll fall behind on bug fixes and features, and you'll need to manually bump it. Instead:

1. **Keep `^0.2.34` but add a build-time TS check.** The container's `entrypoint.sh` already compiles TypeScript on startup — if it fails, the container exits with code 2. The real fix is the short-circuit retry logic from Fix 1, which prevents the crash loop from burning through retries on a deterministic failure.

2. **Add a health check after container image rebuild.** After running `./container/build.sh`, do a quick `npm run build` test inside the container to catch TS errors before they hit production. This could be a post-build step in `build.sh`.

3. **If you want more stability:** Use `~0.2.34` (tilde) instead of `^0.2.34` (caret). Tilde only allows patch bumps (`0.2.x`), not minor bumps. But honestly, the short-circuit retry fix is the better defense — it makes the system resilient to *any* deterministic failure, not just SDK version issues.

The root cause wasn't the version range — it was that the system kept retrying a failure that could never succeed. Fix 1 solves the class of problem, not just this instance.
