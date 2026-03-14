# Intent: src/channels/whatsapp.test.ts modifications

## What changed
Added mocks for image-handler and sender-allowlist modules, and 5 test cases for image handling.

## Key sections

### Mocks (top of file)
- Added: `vi.mock('../image-handler.js', ...)` with isImageMessage, downloadImageMessage, saveImageToGroup
- Added: `vi.mock('../sender-allowlist.js', ...)` with isSenderAllowed, loadSenderAllowlist
- Added: imports for downloadImageMessage, saveImageToGroup, isSenderAllowed

### Test cases (inside "message handling" describe block)
- Added: "downloads and saves image from allowed sender"
- Added: "includes caption alongside image path"
- Added: "blocks image download from non-allowed sender"
- Added: "does not skip image without caption"
- Added: "falls back gracefully when image download fails"
- Updated: "extracts caption from imageMessage" → replaced by image-aware tests above

## Invariants (must-keep)
- All existing test cases for text, extendedTextMessage, videoMessage unchanged
- All voice transcription test cases unchanged
- All connection lifecycle tests unchanged
- All LID translation tests unchanged
- All outgoing queue tests unchanged
- All existing mocks (config, logger, db, fs, child_process, baileys, transcription) unchanged
- Test helpers (createTestOpts, triggerConnection, triggerDisconnect, triggerMessages, connectChannel) unchanged
