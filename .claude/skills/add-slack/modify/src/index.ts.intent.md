# Intent: src/index.ts modifications

## What changed
Added Slack as a channel option alongside existing channels.

## Key sections

### Imports (top of file)
- Added: `SlackChannel` from `./channels/slack.js`
- Added: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ONLY` from `./config.js`

### main()
- Added: conditional Slack creation (`if (SLACK_BOT_TOKEN && SLACK_APP_TOKEN)`)
- Changed: WhatsApp conditional to also check `!SLACK_ONLY`

## Invariants
- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged
- Multi-channel infrastructure (channels array, findChannel) already exists from prior skills

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- Any existing channel integrations (Discord, Telegram, etc.)
- The `channelOpts` shared callback object pattern
