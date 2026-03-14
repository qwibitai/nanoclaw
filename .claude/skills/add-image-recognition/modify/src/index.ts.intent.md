# Intent: src/index.ts modifications

## What changed
Added image path transformation for container context and passed it to `formatMessages()` calls.

## Key sections

### Imports (top of file)
- Added: `DATA_DIR` to the config import

### hostToContainerImagePath() — new function
- Placed after `const queue = new GroupQueue()`
- Transforms host paths (`data/images/abc.jpg`) to container paths (`/workspace/images/abc.jpg`)
- Uses `path.relative()` for reliable path transformation

### processGroupMessages()
- Changed: `formatMessages(missedMessages)` to `formatMessages(missedMessages, hostToContainerImagePath)`

### startMessageLoop()
- Changed: `formatMessages(messagesToSend)` to `formatMessages(messagesToSend, hostToContainerImagePath)`

## Invariants
- All state management (loadState/saveState) is unchanged
- `registerGroup()` is unchanged
- `getAvailableGroups()` is unchanged
- `runAgent()` is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged
- All channel creation is unchanged
- Shutdown handlers are unchanged
- The `escapeXml` and `formatMessages` re-exports are unchanged
- The `_setRegisteredGroups` test helper is unchanged
- The `isDirectRun` guard at bottom is unchanged

## Must-keep
- All error handling and cursor rollback logic in processGroupMessages
- The idle timer and typing indicator logic
- The outgoing queue and message deduplication
- Trigger pattern checking for non-main groups
