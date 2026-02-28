# Intent: src/index.ts modifications

## What changed
Refactored from single WhatsApp channel to multi-channel architecture supporting Slack alongside WhatsApp.

## Key sections

### Imports (top of file)
- Added: `SlackChannel` from `./channels/slack.js`
- Added: `SLACK_ONLY` from `./config.js`
- Added: `readEnvFile` from `./env.js`
- Existing: `findChannel` from `./router.js` and `Channel` type from `./types.js` are already present

### Module-level state
- Kept: `let whatsapp: WhatsAppChannel` — still needed for `syncGroupMetadata` reference
- Added: `let slack: SlackChannel | undefined` — direct reference for `syncChannelMetadata`
- Kept: `const channels: Channel[] = []` — array of all active channels

### processGroupMessages()
- Uses `findChannel(channels, chatJid)` lookup (already exists in base)
- Uses `channel.setTyping?.()` and `channel.sendMessage()` (already exists in base)

### startMessageLoop()
- Uses `findChannel(channels, chatJid)` per group (already exists in base)
- Uses `channel.setTyping?.()` for typing indicators (already exists in base)

### main()
- Added: Reads Slack tokens via `readEnvFile()` to check if Slack is configured
- Added: conditional WhatsApp creation (`if (!SLACK_ONLY)`)
- Added: conditional Slack creation (`if (hasSlackTokens)`)
- Changed: scheduler `sendMessage` uses `findChannel()` → `channel.sendMessage()`
- Changed: IPC `syncGroupMetadata` syncs both WhatsApp and Slack metadata
- Changed: IPC `sendMessage` uses `findChannel()` → `channel.sendMessage()`

### Shutdown handler
- Changed from `await whatsapp.disconnect()` to `for (const ch of channels) await ch.disconnect()`
- Disconnects all active channels (WhatsApp, Slack, or any future channels) on SIGTERM/SIGINT

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged (ensureContainerSystemRunning)

## Design decisions

### Double readEnvFile for Slack tokens
`main()` in index.ts reads `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` via `readEnvFile()` to check
whether Slack is configured (controls whether to instantiate SlackChannel). The SlackChannel
constructor reads them again independently. This is intentional — index.ts needs to decide
*whether* to create the channel, while SlackChannel needs the actual token values. Keeping
both reads follows the security pattern of not passing secrets through intermediate variables.

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The outgoing queue flush and reconnection logic (in each channel, not here)
