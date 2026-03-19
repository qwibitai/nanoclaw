# Intent: src/channels/telegram.ts modifications

## What changed

Added voice message transcription support using a local Whisper transcription service.

## Key sections

### TRANSCRIPTION_URL constant
- Added after the imports, before the `sendTelegramMessage` function
- Reads from `process.env.TRANSCRIPTION_URL`, defaults to `http://localhost:8765`

### transcribeVoice() helper function
- Added as a module-level async function, before the `TelegramChannel` class
- Takes a `Buffer` and `filename`, returns `string | null`
- Constructs a multipart/form-data request manually (no external dependencies)
- Posts to `${TRANSCRIPTION_URL}/api/transcribe-sync`
- 2-minute timeout via `AbortSignal.timeout(120_000)`
- Returns trimmed transcript text on success, `null` on any failure
- Logs warnings on failure but never throws

### Voice message handler replacement
- Replaced: `this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));`
- New handler follows the same pattern as the `message:photo` handler:
  1. Extracts thread/topic ID and chat JID
  2. Checks for registered group (returns early if not registered)
  3. Downloads voice file from Telegram API using `ctx.api.getFile()` + fetch
  4. Calls `transcribeVoice()` with the downloaded buffer
  5. Formats content as `[Voice message]: <transcript>` on success
  6. Falls back to `[Voice message -- transcription unavailable]` on failure
  7. Stores via `onChatMetadata` and `onMessage` (same as photo handler)
  8. Logs result with `transcribed` boolean

### Health check in connect()
- Added inside the `onStart` callback, just before `resolve()`
- Fetches `${TRANSCRIPTION_URL}/health` with 3-second timeout
- Logs info on success, warns on failure
- Non-blocking: does not prevent bot from starting

## Invariants

- All existing message handlers are preserved unchanged (text, photo, video, audio, document, sticker, location, contact)
- The `storeNonText` helper function is preserved unchanged
- Bot commands registration (`setMyCommands`) is preserved unchanged
- All existing imports are preserved
- The `sendTelegramMessage`, `initBotPool`, `sendPoolMessage` functions are unchanged
- The `TelegramChannel` class interface is unchanged (same constructor, same methods)
- The `registerChannel` call at the bottom is unchanged

## Must-keep

- All existing `this.bot.on(...)` handlers
- The `storeNonText` helper and all its callers
- The `onStart` callback structure including bot commands registration
- The `sendTelegramMessage` markdown-with-fallback function
- The bot pool functions (`initBotPool`, `sendPoolMessage`)
- All class methods (`sendMessage`, `sendImage`, `isConnected`, `ownsJid`, `disconnect`, `setTyping`, `sendDraft`)
- The `registerChannel` factory at the bottom of the file
