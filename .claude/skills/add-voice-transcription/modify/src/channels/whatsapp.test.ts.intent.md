# Intent: src/channels/whatsapp.test.ts modifications

## What changed
Added mock for the transcription module and 3 new test cases for voice message handling.

## Key sections

### Mocks (top of file)
- Added: `vi.mock('../transcription.js', ...)` with `isVoiceMessage` and `transcribeAudioMessage` mocks
- Added: `import { transcribeAudioMessage } from '../transcription.js'` for test assertions

### Test cases (inside "message handling" describe block)
- Changed: "handles message with no extractable text (e.g. voice note without caption)" → "transcribes voice messages"
  - Now expects `[Voice: Hello this is a voice message]` instead of empty content
- Added: "falls back when transcription returns null" — expects `[Voice Message - transcription unavailable]`
- Added: "falls back when transcription throws" — expects `[Voice Message - transcription failed]`

## Invariants (must-keep)
- All existing test cases for text, extendedTextMessage, imageMessage, videoMessage unchanged
- All connection lifecycle tests unchanged
- All LID translation tests unchanged
- All outgoing queue tests unchanged
- All group metadata sync tests unchanged
- All ownsJid and setTyping tests unchanged
- All existing mocks (config, logger, db, fs, child_process, baileys) unchanged
- Test helpers (createTestOpts, triggerConnection, triggerDisconnect, triggerMessages, connectChannel) unchanged
