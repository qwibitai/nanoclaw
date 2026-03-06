# Intent: src/channels/whatsapp.ts modifications

## What changed
Added image message handling. When an image arrives, it is downloaded via Baileys,
saved to the group's images/ directory, and the agent receives a prompt to read the
file path. Sender allowlist is checked before downloading.

## Key sections

### Imports (top of file)
- Added: `isImageMessage`, `downloadImageMessage`, `saveImageToGroup` from `../image-handler.js`
- Added: `isSenderAllowed`, `loadSenderAllowlist` from `../sender-allowlist.js`

### Content skip guard
- Changed: `if (!content && !isVoiceMessage(msg)) continue;`
  → `if (!content && !isVoiceMessage(msg) && !isImageMessage(msg)) continue;`
  (image messages may have no text content but should still be processed)

### messages.upsert handler (after voice handling block)
- Added: `isImageMessage(msg)` check
- Added: sender allowlist check via `isSenderAllowed()`
- Added: try/catch calling `downloadImageMessage()` + `saveImageToGroup()`
  - Success: `finalContent = '[Image with caption: "..." — view it by reading: /workspace/group/images/file.jpg]'`
  - Download fail: `finalContent = content || '[Image - download failed]'`
  - Unauthorized: `finalContent = content || '[Image from unauthorized sender]'`

## Invariants (must-keep)
- All existing message handling (conversation, extendedTextMessage, videoMessage) unchanged
- Voice transcription handling unchanged (isVoiceMessage block untouched)
- Connection lifecycle (connect, reconnect, disconnect) unchanged
- LID translation logic unchanged
- Outgoing message queue unchanged
- Group metadata sync unchanged
- sendMessage prefix logic unchanged
- setTyping, ownsJid, isConnected — all unchanged
