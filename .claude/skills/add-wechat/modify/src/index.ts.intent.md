# Intent: src/index.ts modifications

## What changed
Added WeChat channel support to the multi-channel architecture using the `Channel` interface.

## Key sections

### Imports (top of file)
- Added: `WeixinChannel` from `./channels/weixin.js`
- Added: `WEIXIN_ENABLED` from `./config.js`

### main()
- Added: conditional WeChat creation (`if (WEIXIN_ENABLED)`)
- Pattern: Same as QQBot - try/catch with warning on failure, continues without it
- Location: After QQBot initialization, before WhatsApp initialization

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged (ensureContainerRuntimeRunning)
- Other channel initialization code is unchanged

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The channel initialization order and error handling patterns
- The `channels` array and `findChannel` usage throughout
