# Intent: src/index.ts modifications

## What changed
Wired the new optional IPC deps for reactions, replies, and polls with fallback behavior. Added /chatid command handler. Added group metadata snapshot before agent invocation.

## Key sections

### Imports
- Added: `GroupMetadata` from `./types.js`
- Added: `writeGroupMetadataSnapshot` from `./container-runner.js`

### /chatid command handler
- In the `onMessage` callback, intercepts `/chatid` messages before they reach the agent
- Replies with the raw chat JID so users can find their group's ID for registration
- Returns early — message is not stored or forwarded

### IPC deps wiring
- `sendReaction`: finds channel via `findChannel`, throws if channel doesn't support reactions
- `sendReply`: finds channel, falls back to `sendMessage` if `sendReply` not implemented
- `sendPoll`: finds channel via `findChannel`, throws if channel doesn't support polls

### writeGroupMetadataSnapshot
- Called in `runAgent()` before container invocation
- Writes the channel's group metadata to the IPC directory so the container's `get_group_info` MCP tool can read it
- Uses optional chaining: `channel.getGroupMetadata?.(chatJid)`

## Invariants
- All existing message processing (triggers, cursors, idle timers) unchanged
- The `runAgent` function logic unchanged except for the metadata snapshot addition
- State management (loadState/saveState) unchanged
- Recovery logic unchanged
- Container runtime check unchanged
- Outgoing queue flush and reconnection logic unchanged
