# Intent: Add MarkdownV2 formatting to Telegram outgoing messages

Replace plain-text `sendMessage` calls with MarkdownV2-formatted sends.

## What changed

1. Import `Api` from grammy (needed for type signatures)
2. Added `toMarkdownV2()` — escapes MarkdownV2 special characters while
   preserving `*bold*`, `_italic_`, `` `code` ``, and ` ```code blocks``` `
3. Added `sendFormattedMessage()` — sends with `parse_mode: MarkdownV2`,
   falls back to plain text if Telegram rejects the markup
4. Added `sendChunked()` — handles 4096-char splitting with formatting
5. `TelegramChannel.sendMessage()` now delegates to `sendChunked()`

## Invariants

- All outgoing messages attempt MarkdownV2 first
- If MarkdownV2 fails (malformed markup), message is always delivered as plain text
- Message splitting at 4096 chars is preserved
- No changes to inbound message handling
