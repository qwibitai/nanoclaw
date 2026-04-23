# Intent: src/ipc.ts modifications

## What changed
Added memory IPC processing to the IPC watcher loop and a new `processMemoryIpc()` function.

## Key sections
- **Imports**: Added memory function imports from `./memory.js` (`addCoreMemoryWithEmbedding`, `removeCoreMemory`, `searchAllMemory`, `updateCoreMemoryWithEmbedding`)
- **processIpcFiles loop**: Added a new block after task processing that scans `{ipcDir}/{group}/memory/` for JSON files (excluding `res-*` response files) and processes them via `processMemoryIpc()`
- **processMemoryIpc()**: New function handling four IPC types: `memory_add`, `memory_update`, `memory_remove`, `memory_search`. Uses request-response pattern for search (writes `res-{requestId}.json`).
- **isMain detection**: Uses `folderIsMain` Map built from `group.isMain` property (same as upstream pattern)

## Invariants
- All existing IPC message and task processing is unchanged
- The `IpcDeps` interface keeps the `syncGroups` method name (upstream pattern)
- Authorization logic for messages, tasks, and register_group is preserved exactly
- The error-file-move pattern for failed IPC processing is preserved
- The `processTaskIpc` function signature and logic are identical to upstream

## Must-keep
- The `folderIsMain` Map pattern for determining isMain from registered groups
- The `syncGroups` method on IpcDeps (not `syncGroupMetadata`)
- All existing task IPC types (schedule_task, pause_task, resume_task, cancel_task, refresh_groups, register_group)
- Error handling with move-to-errors-dir pattern
- The "defense in depth" comment on register_group
