# Intent: src/task-scheduler.ts modifications

## What changed
Scheduled tasks now receive memory context (RAG) just like regular messages, and a memory snapshot is written so the container agent can manage memories.

## Key sections
- **Imports**: Added `import path from 'path'`, `import { buildMemorySnapshot, retrieveMemoryContext } from './memory.js'`, `import { resolveGroupIpcPath } from './group-folder.js'`, and `import { NewMessage } from './types.js'`
- **runTask() — memory retrieval**: After writing the tasks snapshot, calls `retrieveMemoryContext()` with the task prompt wrapped as a `NewMessage`, prepends the result to the prompt
- **runTask() — memory snapshot**: Writes `memory_snapshot.json` to the group's IPC directory via `resolveGroupIpcPath()` so the container agent can see existing memory IDs
- **runTask() — prompt composition**: Changed from `prompt: task.prompt` to `prompt: memoryContext + task.prompt` (the `prompt` variable now includes memory context)

## Invariants
- The `computeNextRun()` function is unchanged (upstream addition from community PR)
- The `SchedulerDependencies` interface is unchanged
- Invalid group folder handling (pausing task) is unchanged
- Group lookup logic is unchanged
- Task close delay pattern is unchanged
- The scheduler loop, `startSchedulerLoop`, and `_resetSchedulerLoopForTests` are unchanged
- `isMain` detection uses `group.isMain === true` (upstream pattern)

## Must-keep
- The `computeNextRun()` function and its export
- The `isMain = group.isMain === true` pattern (not `MAIN_GROUP_FOLDER`)
- All `logTaskRun()` calls with correct fields
- The `TASK_CLOSE_DELAY_MS` pattern for closing task containers
- The `scheduleClose()` callback pattern
- `_resetSchedulerLoopForTests` export
