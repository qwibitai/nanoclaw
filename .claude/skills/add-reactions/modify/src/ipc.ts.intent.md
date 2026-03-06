# Intent: Add reaction handling to IPC watcher

1. Add optional `sendReaction?` callback to `IpcDeps` interface
2. Handle `type: 'reaction'` IPC messages in the message processing loop
3. Apply same authorization logic as text messages (main group or own group only)
4. Call `deps.sendReaction(chatJid, messageId, emoji)` when authorized
