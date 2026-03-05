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
  "prompt": "You are a worker agent. Your task ID is <TASK_ID>. Read /workspace/extra/homie/workers/WORKERS.md for full instructions, then read and execute your task.",
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

## Implementation

### File: `src/ipc.ts`

Add a new case to the `processTaskIpc` switch statement.

#### Type signature update

Add `spawn_agent` fields to the `data` parameter type:

```typescript
// Existing fields remain unchanged. The relevant ones for spawn_agent:
//   type: string
//   prompt?: string
//   groupFolder?: string      // target group folder (already exists in type)
//   context_mode?: string     // already exists in type
```

No new fields needed — `spawn_agent` reuses `prompt`, `groupFolder` (mapped from `group_folder` in the JSON), and `context_mode` which are already in the type definition.

**Note on field naming:** The IPC JSON uses `group_folder` (snake_case) but the TypeScript type uses `groupFolder` (camelCase). The existing `schedule_task` handler already reads `data.groupFolder`. Ensure the JSON parsing maps correctly — check if there's a normalization step or if the field name in the JSON should match the TypeScript property name. If the JSON field is read as-is (no normalization), use `data.group_folder` in the handler and add it to the type.

#### New case

```typescript
case 'spawn_agent': {
  const targetFolder = data.group_folder ?? data.groupFolder;
  if (!targetFolder || !data.prompt) {
    logger.warn({ data }, 'spawn_agent missing required fields');
    break;
  }

  // Validate target folder
  if (!isValidGroupFolder(targetFolder)) {
    logger.warn({ targetFolder }, 'spawn_agent: invalid group folder');
    break;
  }

  // Find the registered group matching this folder
  const targetGroup = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === targetFolder,
  );
  if (!targetGroup) {
    logger.warn({ targetFolder }, 'spawn_agent: group not registered');
    break;
  }

  const [targetJid, targetGroupEntry] = targetGroup;

  // Authorization: non-main groups can only spawn agents for themselves
  if (!isMain && targetFolder !== sourceGroup) {
    logger.warn(
      { sourceGroup, targetFolder },
      'Unauthorized spawn_agent attempt blocked',
    );
    break;
  }

  const contextMode =
    data.context_mode === 'group' || data.context_mode === 'isolated'
      ? data.context_mode
      : 'isolated';

  // Generate a unique task ID for queue tracking
  const spawnId = `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Enqueue directly — bypasses scheduler, runs immediately when a slot opens
  deps.queue.enqueueTask(targetJid, spawnId, async () => {
    // This callback runs inside GroupQueue.runTask()
    // It needs to call runContainerAgent for the target group
    // This requires access to the same deps as task-scheduler.ts
    await deps.spawnAgent(targetJid, targetFolder, data.prompt, contextMode);
  });

  logger.info(
    { spawnId, sourceGroup, targetFolder, contextMode },
    'Agent spawn enqueued via IPC',
  );
  break;
}
```

#### New dependency: `spawnAgent`

Add to the `IpcDeps` interface:

```typescript
export interface IpcDeps {
  // ... existing fields ...
  spawnAgent: (
    targetJid: string,
    groupFolder: string,
    prompt: string,
    contextMode: 'isolated' | 'group',
  ) => Promise<void>;
}
```

### File: `src/index.ts`

Wire up the `spawnAgent` dependency when creating `IpcDeps`. The implementation should mirror the `runTask` function in `src/task-scheduler.ts` but simplified (no schedule handling, no next_run calculation):

```typescript
spawnAgent: async (targetJid, groupFolder, prompt, contextMode) => {
  const groups = registeredGroups();
  const group = Object.values(groups).find((g) => g.folder === groupFolder);
  if (!group) {
    logger.error({ groupFolder }, 'spawn_agent: group not found');
    return;
  }

  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(groupFolder, isMain, tasks.map(/* ... same as scheduler ... */));

  const sessionId = contextMode === 'group' ? sessions[groupFolder] : undefined;

  await runContainerAgent(
    group,
    {
      prompt,
      sessionId,
      groupFolder,
      chatJid: targetJid,
      isMain,
      isScheduledTask: false,
      assistantName: ASSISTANT_NAME,
    },
    (proc, containerName) => queue.registerProcess(targetJid, proc, containerName, groupFolder),
    async (streamedOutput) => {
      if (streamedOutput.result) {
        await sendMessage(targetJid, streamedOutput.result);
      }
      if (streamedOutput.status === 'success') {
        queue.notifyIdle(targetJid);
      }
    },
  );
};
```

### Authorization Rules

| Source group | Target group | Allowed? |
|-------------|-------------|----------|
| Main (`homie`) | Any group | Yes |
| Non-main (`worker`) | Same group (`worker`) | Yes |
| Non-main (`worker`) | Different group (`homie`) | **No** |

**Wait — this blocks the worker→planner spawn.** The worker group is non-main and needs to spawn the planner (homie) group. Two options:

#### Option A: Relax authorization for spawn_agent specifically

Allow non-main groups to `spawn_agent` for the main group only. Rationale: spawning a container is not a privilege escalation — the spawned agent runs in its own sandbox with its own permissions. The worst a rogue worker can do is waste tokens by repeatedly spawning the planner.

```typescript
// Authorization: non-main can spawn main (to trigger planner), or self
if (!isMain && targetFolder !== sourceGroup) {
  const targetIsMain = targetGroupEntry.isMain === true;
  if (!targetIsMain) {
    logger.warn(
      { sourceGroup, targetFolder },
      'Unauthorized spawn_agent attempt blocked',
    );
    break;
  }
  // Allow: non-main spawning main (worker triggering planner)
}
```

#### Option B: Worker writes to main group's IPC directory

The worker already has write access to `groups/homie/` (via additional mounts). But it does NOT have write access to `data/ipc/homie/tasks/` — it can only write to `data/ipc/worker/tasks/`. So this option would require mounting the main group's IPC directory into the worker container, which is a bigger change.

**Recommendation: Option A.** It's minimal, secure enough (spawning is not escalation), and keeps the IPC namespace model intact.

## Changes to Orchestrator Instructions (groups/homie/CLAUDE.md)

### Step 6 — Dispatch Worker

Replace the current IPC dispatch (writing `schedule_task` JSON) with:

```markdown
3. **Dispatch the worker** via IPC — write a JSON file to `/workspace/ipc/tasks/<uuid>.json`:
   ```json
   {
     "type": "spawn_agent",
     "group_folder": "worker",
     "prompt": "<worker briefing>",
     "context_mode": "isolated"
   }
   ```
```

The rest of Step 6 remains unchanged (lock.json first, activity log after, self-terminate).

## Changes to Worker Instructions (groups/homie/workers/WORKERS.md)

Add a new step after updating task status and releasing lock:

```markdown
5. **Trigger the next planner tick** — write a JSON file to `/workspace/ipc/tasks/<uuid>.json`:
   ```json
   {
     "type": "spawn_agent",
     "group_folder": "homie",
     "prompt": "Heartbeat tick. Follow your orchestration loop.",
     "context_mode": "isolated"
   }
   ```
   Use a unique filename (e.g., `spawn-<timestamp>.json`). This causes the planner to boot within ~1 second to verify your work and dispatch the next task.
```

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

### Worker spawns planner but lock not yet released

Race condition: worker writes `spawn_agent` for homie before writing `lock.json = {locked: false}`. The planner boots, sees the lock is still held, and exits (Step 3 — "Worker running normally. HEARTBEAT_OK"). Next heartbeat will pick it up.

**Mitigation in WORKERS.md:** Instruct workers to release lock BEFORE writing `spawn_agent`. The order should be:

1. Update task via `mc`
2. Release lock (`echo '{"locked": false}' > lock.json`)
3. Write `spawn_agent` IPC file
4. Self-terminate

### Concurrency limit

If `MAX_CONCURRENT_CONTAINERS` slots are full, the spawn goes into `GroupQueue.waitingGroups` and runs when a slot opens. No work is lost.

## Testing

### Manual test

1. Start NanoClaw with planner heartbeat active
2. Verify planner dispatches worker via `spawn_agent` (check logs for `"Agent spawn enqueued via IPC"`)
3. Verify worker container starts within ~2 seconds of IPC file being written
4. Verify worker triggers planner via `spawn_agent` after task completion
5. Verify planner boots, verifies work, and dispatches next task

### Unit test considerations

- Test `processTaskIpc` with `type: 'spawn_agent'` and valid/invalid inputs
- Test authorization: non-main → main (allowed), non-main → non-main (blocked)
- Test missing fields (no prompt, no group_folder)
- Test `queue.enqueueTask` is called with correct arguments

## Summary of file changes

| File | Change |
|------|--------|
| `src/ipc.ts` | Add `spawn_agent` case + `spawnAgent` to `IpcDeps` |
| `src/index.ts` | Wire up `spawnAgent` implementation in IPC deps |
| `src/group-queue.ts` | Add `hasActiveOrPending(groupJid)` method for spawn deduplication |
| `groups/homie/CLAUDE.md` | Step 6: use `spawn_agent` instead of `schedule_task` |
| `groups/homie/workers/WORKERS.md` | Add step: trigger planner via `spawn_agent` after lock release |

No changes to: `src/task-scheduler.ts`, `src/container-runner.ts`, `src/config.ts`.
