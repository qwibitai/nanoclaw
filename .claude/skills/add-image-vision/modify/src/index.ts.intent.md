# Intent: src/index.ts

## What Changed
- Added `import { parseImageReferences } from './image.js'`
- In `processGroupMessages`: extract image references after formatting, pass `imageAttachments` to `runAgent`
- In `runAgent`: added `imageAttachments` parameter, conditionally spread into `runContainerAgent` input

## Key Sections
- **Imports** (top of file): parseImageReferences
- **processGroupMessages**: Image extraction, threading to runAgent
- **runAgent**: Signature change + imageAttachments in input

## Invariants (must-keep)
- State management (lastTimestamp, sessions, registeredGroups, lastAgentTimestamp)
- loadState/saveState functions
- registerGroup function with folder validation
- getAvailableGroups function
- processGroupMessages trigger logic, cursor management, idle timer, error rollback with duplicate prevention
- runAgent task/group snapshot writes, session tracking, wrappedOnOutput
- startMessageLoop with dedup-by-group and piping logic
- recoverPendingMessages startup recovery
- main() with channel setup, scheduler, IPC watcher, queue
- ensureContainerSystemRunning using container-runtime abstraction
- Graceful shutdown with queue.shutdown
