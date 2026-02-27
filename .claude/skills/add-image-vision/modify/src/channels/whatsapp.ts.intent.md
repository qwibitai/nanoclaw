# Intent: src/channels/whatsapp.ts

## What Changed
- Added `downloadMediaMessage` import from Baileys
- Added `GROUPS_DIR` to config import
- Added `isImageMessage`, `processImage` imports from `../image.js`
- Changed `const content =` to `let content =` (allows mutation by image/voice/PDF handlers)
- Added image download/process block between content extraction and `!content` guard

## Key Sections
- **Imports** (top of file): Three new imports added
- **messages.upsert handler** (inside `connectInternal`): Image processing block inserted after text/caption extraction, before the `!content` skip guard

## Invariants (must-keep)
- WhatsAppChannel class structure and all existing methods
- Connection lifecycle (connect, reconnect, disconnect)
- LID-to-phone translation logic
- Outgoing message queue and flush logic
- Group metadata sync
- The `!content` guard must remain AFTER the image block (images provide content for otherwise-empty messages)
- The `const`→`let` change on `content` is shared with voice/PDF skills; all three need mutable content
