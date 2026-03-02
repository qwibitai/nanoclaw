# Intent: src/index.ts

## What Changed
- Added `import { parseImageReferences } from './image.js'`
- In `processGroupMessages`: extract image references after formatting messages
- In `processGroupMessages`: pass `imageAttachments` to `runAgent`
- In `runAgent`: added `imageAttachments` parameter to function signature
- In `runAgent`: conditionally spread `imageAttachments` into `runContainerAgent` input

## Key Sections
- **Imports** (top of file): One new import for parseImageReferences
- **processGroupMessages**: Two additions — extraction call and threading to runAgent
- **runAgent**: Signature change + input object change

## Invariants (must-keep)
- State management (lastTimestamp, sessions, registeredGroups, lastAgentTimestamp)
- loadState/saveState functions
- registerGroup function and group folder creation logic
- getAvailableGroups function
- processGroupMessages trigger logic, cursor management, idle timer, error rollback
- runAgent task/group snapshot writes, session tracking, wrappedOnOutput
- startMessageLoop with its dedup-by-group and piping logic
- recoverPendingMessages startup recovery
- main() function with channel setup, scheduler, IPC watcher, queue
- All existing runContainerAgent input fields preserved
