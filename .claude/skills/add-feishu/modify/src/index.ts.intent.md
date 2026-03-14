# Intent: Connect sendMedia callback in IPC watcher deps

Wire the `sendMedia` callback into the `startIpcWatcher` deps so the IPC watcher can route media messages to the appropriate channel.

**Changes:**
1. Import `MediaPayload` from `types.js`
2. Add `sendMedia` callback to the `startIpcWatcher` deps object:
   - Finds the channel that owns the JID
   - Checks if the channel supports `sendMedia`
   - Logs a warning and returns if the channel doesn't support media
   - Otherwise delegates to `channel.sendMedia()`

**Invariants:**
- All existing IPC deps remain unchanged
- Channels without `sendMedia` gracefully skip (no crash)
- Preserve unrelated startup, scheduler, routing, and queue logic in `src/index.ts`
