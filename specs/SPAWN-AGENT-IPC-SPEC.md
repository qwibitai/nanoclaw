# spawn_agent IPC Action — Implementation Spec

## Overview

Add a new `spawn_agent` IPC action that immediately spawns a container agent for a target group, bypassing the scheduler/SQLite pipeline. This enables ~1 second latency for planner-worker orchestration instead of the current ~61 second worst-case through `schedule_task`.

Both the planner and worker use `spawn_agent` to trigger each other, creating a ping-pong loop with minimal idle time between task completions and the next dispatch.

## Motivation

The current `schedule_task` IPC flow has two stacked polling delays:

1. IPC watcher polls every **1 second** (`IPC_POLL_INTERVAL`) — picks up the JSON file
2. Scheduler loop polls every **60 seconds** (`SCHEDULER_POLL_INTERVAL`) — picks up the SQLite row

This is appropriate for scheduled/recurring tasks but creates unnecessary latency when the planner wants to immediately spawn a worker (or vice versa).

## Architecture

### Flow: Planner dispatches Worker

```
Heartbeat (15-min) → Planner container boots
  → Planner reads state, selects task, writes lock.json
  → Planner writes spawn_agent IPC file targeting "worker" group
  → Planner self-terminates
  → IPC watcher picks up file (~1s)
  → Host calls queue.enqueueTask() → Worker container spawns immediately
```

### Flow: Worker triggers Planner

```
Worker finishes task
  → Worker updates task via mc CLI, releases lock.json
  → Worker writes spawn_agent IPC file targeting "homie" group
  → Worker self-terminates
  → IPC watcher picks up file (~1s)
  → Host calls queue.enqueueTask() → Planner container spawns immediately
  → Planner verifies completed work, dispatches next task (back to flow above)
```

### Heartbeat as fallback

The existing 15-minute heartbeat scheduled task remains unchanged. It serves as a recovery mechanism:

- If the worker crashes without writing `spawn_agent`, the next heartbeat will detect the stale lock and reconcile
- If the planner crashes mid-dispatch, the heartbeat will retry
- Daily briefing check still runs on heartbeat tick

The heartbeat is no longer the primary orchestration driver — `spawn_agent` ping-pong handles the happy path.

## IPC File Format

Written to `data/ipc/{source_group}/tasks/{uuid}.json`:

```json
{
  "type": "spawn_agent",
  "group_folder": "worker",
  "prompt": "You are a worker agent. Your task ID is <TASK_ID>. Read /workspace/extra/homie/workers/CLAUDE.md for full instructions, then read and execute your task.",
  "context_mode": "isolated"
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"spawn_agent"` | yes | IPC action type |
| `group_folder` | `string` | yes | Target group's folder name (e.g., `"worker"`, `"homie"`) |
| `prompt` | `string` | yes | The prompt to pass to the container agent |
| `context_mode` | `"isolated" \| "group"` | no | Session context mode. Defaults to `"isolated"` |


## Edge Cases

### Worker crashes without triggering planner

The 15-minute heartbeat still fires. The planner will detect the stale lock via timeout/grace logic (Step 3 in CLAUDE.md) and reconcile.

### Duplicate planner spawns

If both a `spawn_agent` and the heartbeat fire around the same time, two planner runs could be triggered for the `homie` group. `GroupQueue` guarantees only one container runs per group JID at a time — the second enqueue goes into `pendingTasks` and waits. So two planners never run **concurrently**.

However, the queued second planner will still run after the first finishes. By that point the first planner has already dispatched a worker and written the lock. The second planner boots, reads lock.json, sees `locked: true`, and exits — but it still burns tokens loading the Claude session just to bail.

**Mitigation: host-level deduplication in `spawn_agent` handler.**

Before enqueuing, check if the target group already has an active container or a pending spawn in the queue. If so, skip:

```typescript
case 'spawn_agent': {
  // ... validation ...

  // Dedup: skip if target group already has an active or pending spawn
  if (deps.queue.hasActiveOrPending(targetJid)) {
    logger.debug(
      { targetFolder, sourceGroup },
      'spawn_agent skipped: target group already active or queued',
    );
    break;
  }

  // ... enqueue ...
}
```

This requires adding a `hasActiveOrPending(groupJid)` method to `GroupQueue`:

```typescript
hasActiveOrPending(groupJid: string): boolean {
  const state = this.groups.get(groupJid);
  if (!state) return false;
  return state.active || state.pendingTasks.length > 0;
}
```

With this, even if a heartbeat and a `spawn_agent` fire simultaneously, only the first one enqueues. The second is silently dropped at the IPC layer — zero tokens wasted.

**Note:** This is safe because the heartbeat will fire again in 15 minutes if the dropped spawn was the only path to recovery. The dedup only prevents redundant spawns, never the last resort.

**Mitigation in WORKERS.md:** Instruct workers to release lock BEFORE writing `spawn_agent`. The order should be:

1. Update task via `mc`
2. Release lock (`echo '{"locked": false}' > lock.json`)
3. Write `spawn_agent` IPC file
4. Self-terminate

## Testing

### Unit test considerations

- Test `processTaskIpc` with `type: 'spawn_agent'` and valid/invalid inputs
- Test missing fields (no prompt, no group_folder)
- Test `queue.enqueueTask` is called with correct arguments

## Summary of file changes

| File | Change |
|------|--------|
| `src/ipc.ts` | Add `spawn_agent` case + `spawnAgent` to `IpcDeps` |
| `src/index.ts` | Wire up `spawnAgent` implementation in IPC deps |
| `src/group-queue.ts` | Add `hasActiveOrPending(groupJid)` method for spawn deduplication |
| `groups/homie/CLAUDE.md` | Step 6: use `spawn_agent` instead of `schedule_task` |
| `groups/homie/workers/CLAUDE.md` | Add step: trigger planner via `spawn_agent` after lock release |

No changes to: `src/task-scheduler.ts`, `src/container-runner.ts`, `src/config.ts`.
