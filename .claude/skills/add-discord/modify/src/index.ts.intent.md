# Intent: src/index.ts modifications

## What changed
Added Discord as a channel option alongside WhatsApp, introducing multi-channel infrastructure.

## Key sections

### Imports (top of file)
- Added: `DiscordChannel` from `./channels/discord.js`
- Added: `DISCORD_BOT_TOKEN`, `DISCORD_ONLY` from `./config.js`
- Added: `findChannel` from `./router.js`
- Added: `Channel` from `./types.js`

### Multi-channel infrastructure
- Added: `const channels: Channel[] = []` array to hold all active channels
- Changed: `processGroupMessages` uses `findChannel(channels, chatJid)` instead of `whatsapp` directly
- Changed: `startMessageLoop` uses `findChannel(channels, chatJid)` instead of `whatsapp` directly
- Changed: `channel.setTyping?.()` instead of `whatsapp.setTyping()`
- Changed: `channel.sendMessage()` instead of `whatsapp.sendMessage()`

### getAvailableGroups()
- Unchanged: uses `c.is_group` filter from base (Discord channels pass `isGroup=true` via `onChatMetadata`)

### main()
- Added: `channelOpts` shared callback object for all channels
- Changed: WhatsApp conditional to `if (!DISCORD_ONLY)`
- Added: conditional Discord creation (`if (DISCORD_BOT_TOKEN)`)
- Changed: shutdown iterates `channels` array instead of just `whatsapp`
- Changed: subsystems use `findChannel(channels, jid)` for message routing

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
