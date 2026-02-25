# Intent: src/index.ts modifications

## What changed

Added Gmail as a channel.

## Key sections

### Imports (top of file)

- Added: `GmailChannel` from `./channels/gmail.js`

### main()

- Added Gmail channel creation:
  ```
  const gmail = new GmailChannel(channelOpts);
  channels.push(gmail);
  await gmail.connect();
  ```
- Gmail uses the same `channelOpts` callbacks as other channels
- Incoming emails are delivered to the main group (agent decides how to respond, user can configure)

## Invariants

- All existing message processing logic (triggers, cursors, idle timers) is preserved
- The `runAgent` function is completely unchanged
- State management (loadState/saveState) is unchanged
- Recovery logic is unchanged
- Container runtime check is unchanged
- Any other channel creation is untouched
- Shutdown iterates `channels` array (Gmail is included automatically)

## Must-keep

- The `escapeXml` and `formatMessages` re-exports
- The `_setRegisteredGroups` test helper
- The `isDirectRun` guard at bottom
- All error handling and cursor rollback logic in processGroupMessages
- The outgoing queue flush and reconnection logic
