# Intent: src/index.ts modifications

## What changed
Added Slack channel support to the multi-channel architecture.

## Key sections

### Imports (top of file)
- Added: `SlackChannel` from `./channels/slack.js`
- Added: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ONLY` from `./config.js`

### main() - Channel creation
- Added: Slack channel creation block before Telegram:
  ```typescript
  if (SLACK_BOT_TOKEN && SLACK_APP_TOKEN) {
    const slack = new SlackChannel(SLACK_BOT_TOKEN, SLACK_APP_TOKEN, channelOpts);
    channels.push(slack);
    await slack.connect();
  }
  ```
- Note: Both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are required for Slack (Socket Mode needs both)

### main() - WhatsApp conditional
- Changed: `if (!TELEGRAM_ONLY)` → `if (!TELEGRAM_ONLY && !SLACK_ONLY)`
- This allows SLACK_ONLY=true to disable WhatsApp just like TELEGRAM_ONLY does

## Invariants
- All existing message processing logic is preserved
- Channel ordering: Slack first, then Telegram, then WhatsApp (order matters for initialization logs)
- The `runAgent` function is unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- findChannel() routing uses ownsJid() which each channel implements

## Must-keep
- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The shared `channelOpts` pattern for all channels
- Graceful shutdown that disconnects all channels
