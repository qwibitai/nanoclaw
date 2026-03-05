# Intent: src/channels/telegram.test.ts modifications

## What changed
Added voice transcription test coverage. The old single "stores voice message with placeholder" test is replaced with 5 tests covering the full transcription flow.

## Key sections

### Mocks added
- `vi.mock('../transcription.js')` with `mockTranscribeAudio` function
- `getFile` added to Grammy mock bot's `api` object
- `api.getFile` added to `createMediaCtx` return value
- Global `fetch` stubbed in `beforeEach`, restored in `afterEach`

### Tests replaced
Old: "stores voice message with placeholder" (single test)
New: 5 tests:
1. "transcribes voice message successfully" — mock returns text, expects `[Voice: ...]`
2. "falls back when transcription returns null" — expects `[Voice message - transcription unavailable]`
3. "falls back when voice download fails" — fetch returns `ok: false`
4. "includes caption with transcribed voice message" — expects `[Voice: ...] caption`
5. "ignores voice messages from unregistered chats" — no `onMessage` call

## Invariants (must-keep)
- All existing non-voice tests unchanged
- Test helper signatures unchanged
- Grammy mock structure unchanged (only added `getFile` to `api`)
- `createMediaCtx` return shape backward compatible (added `api` field)
