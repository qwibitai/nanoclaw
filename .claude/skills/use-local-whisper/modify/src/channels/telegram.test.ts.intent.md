# Intent: src/channels/telegram.test.ts modifications

## What changed
Added voice transcription test infrastructure and replaced the single voice placeholder test with 5 comprehensive voice transcription tests.

## Key sections

### Mock additions
- Added `mockTranscribeAudio = vi.fn().mockResolvedValue(null)`
- Added `vi.mock('../transcription.js', ...)` with the mock function
- Added `getFile` mock to Grammy MockBot's `api` object
- Added `api: { getFile: vi.fn()... }` to `createMediaCtx` return
- Added global `fetch` stub in `beforeEach` / unstub in `afterEach`

### Replaced test
- Removed: `stores voice message with placeholder` (tested `[Voice message]`)
- Added 5 tests:
  1. `transcribes voice message successfully` — verifies `[Voice: Hello this is a test]`
  2. `falls back when transcription returns null` — verifies fallback message
  3. `falls back when voice download fails` — verifies fetch error handling
  4. `includes caption with transcribed voice message` — verifies caption appended
  5. `ignores voice messages from unregistered chats` — verifies early return

## Invariants (must-keep)
- All existing non-voice tests unchanged (photo, video, audio, document, sticker, location, contact)
- Text message and @mention translation tests unchanged
- sendMessage, ownsJid, setTyping, bot commands tests unchanged
- Test helper functions (`createTestOpts`, `createTextCtx`, `triggerTextMessage`, `triggerMediaMessage`) signatures preserved
- `createMediaCtx` extended (not replaced) with `api` field
