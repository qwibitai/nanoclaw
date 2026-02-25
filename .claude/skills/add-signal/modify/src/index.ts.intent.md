# Intent: src/index.ts modifications

## What changed
Added Signal as a channel option alongside WhatsApp, using the existing multi-channel infrastructure.

## Key sections

### Imports (top of file)
- Added: `SignalChannel` from `./channels/signal.js`
- Added: `SIGNAL_PHONE_NUMBER`, `SIGNAL_CLI_URL`, `SIGNAL_ONLY` from `./config.js`
- Added: `findChannel` from `./router.js` (if not already present)
- Added: `Channel` from `./types.js` (if not already present)

### Multi-channel infrastructure
- Uses existing `const channels: Channel[] = []` array
- Uses existing `findChannel(channels, chatJid)` routing
- No changes to message processing, typing indicators, or send logic

### main()
- Added: conditional Signal creation (`if (SIGNAL_PHONE_NUMBER)`)
- Changed: WhatsApp conditional to `if (!SIGNAL_ONLY)` (or combined with existing `*_ONLY` flags)
- Signal channel is created before WhatsApp in the channel init order

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- Shutdown iterates `channels` array
