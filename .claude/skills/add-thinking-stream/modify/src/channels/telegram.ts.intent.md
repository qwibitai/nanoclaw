# Intent: src/channels/telegram.ts

## What Changed

- Added `sendMessageWithId(jid, text)` method: sends a message and returns the Telegram message_id for later editing
- Added `editMessage(jid, messageId, text)` method: edits a previously sent message, silently ignores "message is not modified" errors

## Key Sections

- **sendMessageWithId**: New method, sends via bot.api.sendMessage, returns message_id
- **editMessage**: New method, edits via bot.api.editMessageText, error handling for unchanged content

## Invariants (must-keep)

- TelegramChannel constructor, connect, disconnect, isConnected
- ownsJid (tg: prefix matching)
- sendMessage with HTML parse_mode
- syncGroups implementation
- Inbound message handling (bot.on 'message')
- setTyping implementation
- registerChannel factory function at bottom
- All existing error handling patterns
