# Intent: src/task-scheduler.ts modifications

## What changed
Use Engine interface instead of direct `container-runner` import for running scheduled tasks.

## Key sections

### Imports
- Removed: `runContainerAgent`, `writeTasksSnapshot`, `writeGroupsSnapshot` from `./container-runner.js`
- Added: `Engine` from `./engine.js` (for type reference)
- Keep: `AvailableGroup` type import if still needed

### SchedulerDependencies interface
- Added: `engine: Engine`
- All other deps unchanged (`registeredGroups`, `sessions`, `setSession`, `sendMessage`, `getAvailableGroups`, etc.)

### runTask / task execution
- Changed: `runContainerAgent(group, {...}, onProcess, onOutput)` → `deps.engine.runAgent(group, {...}, onProcess, onOutput)`
- Input mapping is 1:1 (same fields, same types)
- Output handling unchanged

### Snapshot writes
- Changed: `writeTasksSnapshot(...)` → `if (deps.engine.writeTasksSnapshot) { deps.engine.writeTasksSnapshot(...); }`
- Changed: `writeGroupsSnapshot(...)` → `if (deps.engine.writeGroupsSnapshot) { deps.engine.writeGroupsSnapshot(...); }`

## Invariants
- Cron parsing logic is unchanged
- Task state management (active/paused/completed) is unchanged
- Schedule types (cron, interval, once) are unchanged
- Context modes (group, isolated) are unchanged
- Error handling and retry logic is unchanged
- The `onProcess` callback still registers the process with GroupQueue

## Must-keep
- All task scheduling logic (next run calculation, cron expressions)
- The `SCHEDULER_POLL_INTERVAL` polling loop
- Task status updates in the database
- The isolated vs group context mode distinction
- Error recovery and logging
