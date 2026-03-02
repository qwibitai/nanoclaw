# Intent: src/index.ts modifications

## What changed
Refactored from single WhatsApp channel to multi-channel architecture using the `Channel` interface, with Signal as a second channel.

## Key sections

### Imports (top of file)
- Added: `SignalChannel` from `./channels/signal.js`
- Added: `SIGNAL_ONLY`, `SIGNAL_PHONE_NUMBER` from `./config.js`
- Added: `findChannel` from `./router.js`
- Added: `Channel` type from `./types.js`

### Module-level state
- Added: `const channels: Channel[] = []` — array of all active channels
- Changed: `let whatsapp` type from `WhatsAppChannel` to `WhatsAppChannel | undefined` (may be skipped when SIGNAL_ONLY)

### processGroupMessages()
- Added: `findChannel(channels, chatJid)` lookup at the start
- Changed: `whatsapp.setTyping()` → `channel.setTyping?.()` (optional chaining)
- Changed: `whatsapp.sendMessage()` → `channel.sendMessage()` in output callback

### startMessageLoop()
- Added: `findChannel(channels, chatJid)` lookup per group in message processing
- Changed: `whatsapp.setTyping()` → `channel.setTyping?.()` for typing indicators

### main()
- Changed: shutdown disconnects all channels via `for (const ch of channels)`
- Added: shared `channelOpts` object for channel callbacks
- Added: conditional WhatsApp creation (`if (!SIGNAL_ONLY)`)
- Added: conditional Signal creation (`if (SIGNAL_PHONE_NUMBER)`)
- Changed: scheduler `sendMessage` uses `findChannel()` → `channel.sendMessage()`
- Changed: IPC `sendMessage` uses `findChannel()` → `channel.sendMessage()`

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged (ensureContainerSystemRunning)

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The outgoing queue flush and reconnection logic (in WhatsAppChannel, not here)
