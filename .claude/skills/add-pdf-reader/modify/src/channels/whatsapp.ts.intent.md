# Intent: src/channels/whatsapp.ts modifications

## What changed
Added PDF attachment download and path injection. When a WhatsApp message contains a PDF document, it is downloaded to the group's attachments/ directory and the message content is replaced with the file path and a usage hint. Also uses `normalizeMessageContent()` from Baileys to unwrap container types before reading fields.

## Key sections

### Imports (top of file)
- Added: `downloadMediaMessage` from `@whiskeysockets/baileys`
- Added: `normalizeMessageContent` from `@whiskeysockets/baileys`
- Added: `GROUPS_DIR` from `../config.js`

### messages.upsert handler (inside connectInternal)
- Added: `normalizeMessageContent(msg.message)` call to unwrap container types
- Changed: `let content` to allow reassignment for PDF messages
- Added: Check for `normalized.documentMessage?.mimetype === 'application/pdf'`
- Added: Download PDF via `downloadMediaMessage`, save to `groups/{folder}/attachments/`
- Added: Replace content with `[PDF: attachments/{filename} ({size}KB)]` and usage hint
- Note: PDF check is placed BEFORE the `if (!content) continue;` guard so PDF-only messages are not skipped

## Invariants (must-keep)
- All existing message handling (conversation, extendedTextMessage, imageMessage, videoMessage)
- Connection lifecycle (connect, reconnect with exponential backoff, disconnect)
- LID translation logic unchanged
- Outgoing message queue unchanged
- Group metadata sync unchanged
- sendMessage prefix logic unchanged
- setTyping, ownsJid, isConnected — all unchanged
- Local timestamp format (no Z suffix)
