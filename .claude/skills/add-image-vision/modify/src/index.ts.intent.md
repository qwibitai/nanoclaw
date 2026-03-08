# Intent: src/index.ts

## What Changed
- Added `import { parseImageReferences } from './image.js'`
- In `runAgent`: added optional `imageAttachments` parameter (5th), conditionally spread into `runContainerAgent` input
- In `buildProcessorDeps`: `runAgent` wrapper forwards the 5th `imageAttachments` param

## Key Sections
- **Imports** (top of file): parseImageReferences
- **runAgent function**: Signature change + imageAttachments in container input
- **buildProcessorDeps**: runAgent wrapper forwards imageAttachments

## Invariants (must-keep)
- State management (lastTimestamp, sessions, registeredGroups, lastAgentTimestamp, pendingSendCursor)
- loadState/saveState functions
- registerGroup/unregisterGroup functions with folder validation
- getAvailableGroups function
- buildHandlerDeps with sendMessage, registeredGroups, registerGroup, unregisterGroup, syncGroups, getAvailableGroups
- buildProcessorDeps with all existing fields
- processGroupMessages and recoverPendingMessages imported from message-processor.ts
- startMessageLoop with dedup-by-group, optimistic cursor, and async piping logic
- main() with channel setup, scheduler, queue, handler deps
- ensureContainerSystemRunning using container-runtime abstraction
- Graceful shutdown with queue.shutdown
- No inline processGroupMessages (it's in message-processor.ts)
- No startIpcWatcher (removed in stdio IPC migration)
- No writeTasksSnapshot/writeGroupsSnapshot (removed in stdio IPC migration)
