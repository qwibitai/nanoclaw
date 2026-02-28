# Intent: src/index.ts modifications

## What changed

Added Feishu channel support to the multi-channel architecture.

## Key sections

### Imports (top of file)
- Added: `FeishuChannel` from `./channels/feishu.js`
- Added: `readEnvFile` from `./env.js`
- Added: `DATA_DIR` from `./config.js`
- Added: `deleteRegisteredGroup` from `./db.js`

### Module-level state
- Added: `let feishu: FeishuChannel` — reference for syncGroupMetadata
- Added: `const channels: Channel[] = []` — array of all active channels

### processGroupMessages()
- Changed: Removed trigger requirement by using `if (false && ...)` pattern

### startMessageLoop()
- Changed: `needsTrigger` always false so bot responds to all messages

### channelOpts
- Added: `registerGroup` callback for auto-registration
- Added: `unregisterGroup` callback for group disband cleanup

### unregisterGroup()
- New function that:
  1. Deletes group from database
  2. Removes from registeredGroups map
  3. Deletes groups/{folder} directory
  4. Deletes data/sessions/{folder} directory
  5. Deletes data/ipc/{folder} directory

### main()
- Added: Feishu channel initialization with credentials check
- Changed: Uses `findChannel()` for message routing (existing)

## Invariants

- All existing message processing logic preserved
- The `runAgent` function is unchanged
- State management (loadState/saveState) unchanged
- Container runtime check unchanged

## Must-keep

- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic
