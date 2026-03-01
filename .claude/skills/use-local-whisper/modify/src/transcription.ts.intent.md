# Intent: src/transcription.ts modifications

## What changed
Replaced the OpenAI Whisper API backend with local whisper.cpp CLI execution. Audio is converted from ogg/opus to 16kHz mono WAV via ffmpeg, then transcribed locally using whisper-cpp. No API key or network required.

## Key sections

### Imports
- Removed: `readEnvFile` from `./env.js` (no API key needed)
- Added: `execFile` from `child_process`, `fs`, `os`, `path`, `promisify` from `util`

### Configuration
- Removed: `TranscriptionConfig` interface and `DEFAULT_CONFIG` (no model/enabled/fallback config)
- Added: `WHISPER_BIN` constant (env `WHISPER_BIN` or `'whisper-cli'`)
- Added: `WHISPER_MODEL` constant (env `WHISPER_MODEL` or `data/models/ggml-base.bin`)
- Added: `FALLBACK_MESSAGE` constant

### transcribeWithWhisperCpp (replaces transcribeWithOpenAI)
- Writes audio buffer to temp .ogg file
- Converts to 16kHz mono WAV via ffmpeg
- Runs whisper-cpp CLI with `--no-timestamps -nt` flags
- Cleans up temp files in finally block
- Returns trimmed stdout or null on error

### transcribeAudioMessage
- Same signature: `(msg: WAMessage, sock: WASocket) => Promise<string | null>`
- Same download logic via `downloadMediaMessage`
- Calls `transcribeWithWhisperCpp` instead of `transcribeWithOpenAI`
- Same fallback behavior on error/null

### isVoiceMessage
- Unchanged: `msg.message?.audioMessage?.ptt === true`

## Invariants (must-keep)
- `transcribeAudioMessage` export signature unchanged
- `isVoiceMessage` export unchanged
- Fallback message strings unchanged: `[Voice Message - transcription unavailable]`
- downloadMediaMessage call pattern unchanged
- Error logging pattern unchanged
