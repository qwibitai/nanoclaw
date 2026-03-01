# Intent: src/index.ts modifications

## What changed

Added Google Chat as a channel.

## Key sections

### Imports (top of file)

- Added: `GoogleChatChannel` from `./channels/googlechat.js`

### main()

- Added Google Chat channel creation after Gmail:
  ```
  const googlechat = new GoogleChatChannel(channelOpts);
  channels.push(googlechat);
  try { await googlechat.connect(); } catch (err) {
    logger.warn({ err }, 'Google Chat channel failed to connect, continuing without it');
  }
  ```
- Google Chat uses the same `channelOpts` callbacks as other channels
- Incoming messages are delivered to the main group (agent decides how to respond)

## Invariants

- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged
- Any other channel creation (WhatsApp, Gmail) is untouched
- Shutdown iterates `channels` array (Google Chat is included automatically)

## Must-keep

- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The outgoing queue flush and reconnection logic
