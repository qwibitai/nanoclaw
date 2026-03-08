# Intent: src/message-processor.ts

## What Changed
- Added `import { parseImageReferences } from './image.js'`
- Added `imageAttachments?` as optional 5th parameter to `MessageProcessorDeps.runAgent` type signature
- In `processGroupMessages`: extract image references after formatting with `parseImageReferences(missedMessages)`
- Pass `imageAttachments` as 5th argument to `deps.runAgent()` call

## Key Sections
- **Imports** (top of file): parseImageReferences from image.js
- **MessageProcessorDeps interface**: runAgent signature with imageAttachments
- **processGroupMessages**: Image extraction and threading

## Invariants (must-keep)
- AgentOutput interface unchanged
- MessageProcessorDeps: all other fields unchanged (registeredGroups, findChannel, getAgentCursor, setAgentCursor, queue, assistantName, triggerPattern, idleTimeout, timezone)
- processGroupMessages: trigger logic, cursor management, idle timer with cancelIdleTimer on piped, error rollback with duplicate prevention
- recoverPendingMessages startup recovery function
