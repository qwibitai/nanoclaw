# Intent: src/channels/whatsapp.ts modifications

## What changed
Added WhatsApp image download support. When a user sends an image message, it is downloaded, saved to disk, and passed as `image_path` in the message object.

## Key sections

### Imports (top of file)
- Added: `downloadMediaMessage` to the `@whiskeysockets/baileys` import
- Added: `import crypto from 'crypto'` for generating unique filenames
- Added: `DATA_DIR` to the `../config.js` import

### messages.upsert handler
- Added: Image download block after content extraction, before the "skip protocol messages" check
  - Downloads image via `downloadMediaMessage()` from Baileys
  - Enforces 5MB size limit
  - Saves to `data/images/{random-hash}.jpg`
  - Stores path in `imagePath` variable
- Changed: Skip condition from `if (!content) continue` to `if (!content && !imagePath) continue` to accept image-only messages
- Added: `image_path: imagePath` to the `onMessage()` call

## Invariants
- All existing connection, reconnection, and QR code logic is unchanged
- `sendMessage()` is unchanged
- `syncGroupMetadata()` is unchanged
- `translateJid()` is unchanged
- `flushOutgoingQueue()` is unchanged
- LID to phone mapping is unchanged
- Bot message detection logic is unchanged
- macOS notification code is unchanged (existing, not new)

## Must-keep
- All WhatsApp connection lifecycle management
- The outgoing message queue and prefixing logic
- Group sync timer and interval
- Typing indicator support
