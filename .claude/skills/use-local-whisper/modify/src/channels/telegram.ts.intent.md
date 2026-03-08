# Intent: src/channels/telegram.ts modifications

## What changed
Added voice message transcription to the Telegram channel. The `message:voice` handler now downloads the audio file from the Telegram Bot API, passes it to the channel-agnostic `transcribeAudio(Buffer)` function, and delivers the transcript as `[Voice: <text>]` instead of a static placeholder.

## Key sections

### Imports
- Added: `import { transcribeAudio } from '../transcription.js'`

### Voice handler (replaces `storeNonText(ctx, '[Voice message]')`)
- Checks registered group (early return if unregistered)
- Gets file via `ctx.api.getFile(file_id)` → fetches from `https://api.telegram.org/file/bot{token}/{file_path}`
- Converts response to Buffer
- Calls `transcribeAudio(buffer)`
- On success: `[Voice: <transcript>]`
- On failure/null: `[Voice message - transcription unavailable]`
- Appends caption if present
- Delivers via `onMessage` with full metadata (same pattern as other handlers)

## Invariants (must-keep)
- All other message handlers (photo, video, audio, document, sticker, location, contact) unchanged
- `storeNonText` helper unchanged
- Text message handling and @mention translation unchanged
- `sendMessage`, `ownsJid`, `setTyping`, `connect`, `disconnect` unchanged
- Channel registration factory unchanged
- Error logging uses `logger.error` with structured context
