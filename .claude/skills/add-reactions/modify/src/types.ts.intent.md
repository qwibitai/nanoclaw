# Intent: Add reaction support to type interfaces

1. Add `quoted_message_id`, `quote_sender_name`, `quote_content` optional fields to `NewMessage`
2. Add `Reaction` interface (chatJid, messageId, emoji, timestamp)
3. Add `sendReaction?` and `reactToLatestMessage?` optional methods to `Channel` interface

All additions are backwards-compatible — existing code continues to work without changes.
