# Intent: src/db.ts modifications

## What changed

Added `hasBotResponseAfter(chatJid, sinceTimestamp)` to support message-pipeline deduplication when piped messages are re-checked after container exit.

## Key sections

### Chat lookup helpers

- Added: `hasBotResponseAfter(chatJid, sinceTimestamp)` immediately after `getChatName`
- Query behavior: checks `messages` for any `is_bot_message = 1` row in the same chat with `timestamp > sinceTimestamp`
- Return type: boolean (`true` when a bot response exists, `false` otherwise)

## Why

When messages are piped to an already-running container, the router can re-check pending messages later (drain path). This helper lets `processGroupMessages` detect that the bot already responded and safely advance the cursor without spawning a duplicate run.

## Invariants

- No schema changes
- No changes to existing function signatures
- Existing message read/write behavior remains unchanged
