# Intent: src/index.ts modifications

## What changed

Added Google Chat as a multi-space channel with automatic space discovery, state persistence, and dynamic group registration.

## Key sections

### Imports (top of file)

- Added: `GoogleChatChannel, SpaceInfo` from `./channels/googlechat.js`

### main()

- Added Google Chat channel creation after Gmail with `onSpaceDiscovered` callback:
  ```
  const googlechat = new GoogleChatChannel({
    ...channelOpts,
    getState: getRouterState,
    setState: setRouterState,
    onSpaceDiscovered: (jid: string, space: SpaceInfo) => {
      if (registeredGroups[jid]) return;
      const isDm = space.spaceType === 'DIRECT_MESSAGE';
      registerGroup(jid, {
        name: space.displayName,
        folder: MAIN_GROUP_FOLDER,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: !isDm,
      });
    },
  });
  channels.push(googlechat);
  try { await googlechat.connect(); } catch (err) {
    logger.warn({ err }, 'Google Chat channel failed to connect, continuing without it');
  }
  ```
- `getState`/`setState` callbacks use the existing `getRouterState`/`setRouterState` from db.ts to persist poll timestamps across restarts
- `onSpaceDiscovered` callback auto-registers each discovered space as a group:
  - DMs: `requiresTrigger: false` (no @mention needed)
  - Rooms: `requiresTrigger: true` (needs @mention)
  - All spaces route to `MAIN_GROUP_FOLDER`

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
