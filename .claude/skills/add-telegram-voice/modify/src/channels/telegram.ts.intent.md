# Intent: src/channels/telegram.ts modifications

## What changed
Replaced the `message:voice` handler from a simple `storeNonText` placeholder call to an async handler that downloads the voice file from Telegram's API, transcribes it locally via whisper.cpp, and delivers the transcript to the agent.

## Key sections

### Imports
- Added: `import { transcribeAudio } from '../transcription.js'`

### message:voice handler (replaces storeNonText call)
- Checks registered group first (early return if unregistered)
- Downloads voice file: `ctx.api.getFile(file_id)` -> fetch from Telegram URL -> Buffer
- Calls `transcribeAudio(buffer)` for local whisper.cpp transcription
- Stores `[Voice: <transcript>]` on success
- Falls back to `[Voice message - transcription unavailable]` on failure
- Appends caption if present
- Logs result with `logger.info`

## Invariants (must-keep)
- All other handlers (photo, video, audio, document, sticker, location, contact) unchanged
- `storeNonText` helper unchanged
- Voice handler still emits `onChatMetadata` and `onMessage` with same shape
- Unregistered chats still silently ignored
- Error handling wraps entire download/transcribe flow
