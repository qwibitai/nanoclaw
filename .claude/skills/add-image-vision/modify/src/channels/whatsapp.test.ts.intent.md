# Intent: src/channels/whatsapp.test.ts

## What Changed
- Added `GROUPS_DIR` to config mock
- Added `../image.js` mock (isImageMessage defaults false, processImage returns stub)
- Added `updateMediaMessage` to fake socket (needed by downloadMediaMessage)
- Added `downloadMediaMessage` to Baileys mock
- Added imports for `downloadMediaMessage`, `isImageMessage`, `processImage`
- Added 4 image test cases in the "message handling" describe block

## Key Sections
- **Mock setup** (top of file): New image mock block, extended Baileys mock, extended fakeSocket
- **Message handling tests**: 4 new tests after "extracts caption from imageMessage"
  - `downloads and processes image attachments`
  - `handles image without caption`
  - `handles image download failure gracefully`
  - `falls back to caption when processImage returns null`

## Invariants (must-keep)
- All existing test sections and describe blocks
- Existing mock structure (config, logger, db, fs, child_process, Baileys)
- Test helpers (createTestOpts, triggerConnection, triggerDisconnect, triggerMessages, connectChannel)
- Connection lifecycle, authentication, reconnection, LID translation tests
- Outgoing queue, group metadata sync, JID ownership, typing indicator tests
- The base "extracts caption from imageMessage" test (tests text-only extraction when isImageMessage is false)
- The base "handles message with no extractable text" test (voice note without transcription — onMessage not called)
