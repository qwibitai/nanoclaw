# Intent: src/index.ts modifications

## What changed
Extended from single WhatsApp channel to multi-channel architecture that also supports DingTalk via Stream Mode.

## Key sections

### Imports (top of file)
- Added: `DingTalkChannel` from `./channels/dingtalk.js`
- Added: `DINGTALK_ALLOWED_GROUPS`, `DINGTALK_ALLOWED_USERS`, `DINGTALK_CLIENT_ID`, `DINGTALK_CLIENT_SECRET`, `DINGTALK_ONLY`, `DINGTALK_ROBOT_CODE` from `./config.js`

### Module-level state
- `const channels: Channel[] = []` — array of all active channels (already present in multi-channel base)
- `let whatsapp: WhatsAppChannel` — still needed for `syncGroupMetadata` reference in IPC watcher

### processGroupMessages()
- Uses `findChannel(channels, chatJid)` to dispatch to the correct channel
- Logs a warning if no channel owns the JID (instead of silently failing)

### main() — channel creation block
- **WhatsApp** created conditionally: `if (!DINGTALK_ONLY)` — skipped when DingTalk-only mode
- **DingTalk** created conditionally: `if (DINGTALK_CLIENT_ID && DINGTALK_CLIENT_SECRET)` — disabled when credentials not set
- DingTalkChannel constructor requires 6 args: clientId, clientSecret, robotCode, allowedUsers, allowedGroups, opts
- opts spreads `channelOpts` and adds `registerGroup` — DingTalk needs this for auto-registration

### startMessageLoop()
- Uses `findChannel(channels, chatJid)` per group to dispatch messages and typing indicators
- Logs a warning if no channel owns the JID

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
- The `whatsapp?.syncGroupMetadata` optional chain in IPC watcher
