# Intent: src/channels/whatsapp.test.ts

## What Changed
- Added `GROUPS_DIR` to config mock
- Added `../image.js` mock (isImageMessage defaults false, processImage returns stub)
- Added `updateMediaMessage` to fake socket (needed by downloadMediaMessage)
- Added `normalizeMessageContent` to Baileys mock (pass-through)
- Added `downloadMediaMessage` to Baileys mock (returns Buffer)
- Added imports for `downloadMediaMessage`, `isImageMessage`, `processImage`
- Added image test cases: downloads/processes, no caption, download failure, processImage null fallback

## Key Sections
- **Mock setup** (top of file): New image mock, extended Baileys mock, extended fakeSocket
- **Message handling tests**: Image test cases

## Invariants (must-keep)
- All existing test sections and describe blocks
- Existing mock structure (config, logger, db, fs, child_process, Baileys)
- Test helpers (createTestOpts, triggerConnection, triggerDisconnect, triggerMessages, connectChannel)
- Connection lifecycle, authentication, reconnection, LID translation tests
- Outgoing queue, group metadata sync, JID ownership, typing indicator tests
