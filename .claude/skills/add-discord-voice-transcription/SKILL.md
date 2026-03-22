---
name: add-discord-voice-transcription
description: Add voice message transcription to NanoClaw's Discord channel using local whisper.cpp. When a user sends a voice memo or audio file, it is downloaded, transcribed offline, and delivered to the agent as `[Voice: <transcript>]`.
---

# Add Discord Voice Transcription

Adds automatic voice message transcription to NanoClaw's Discord channel using local whisper.cpp. When an audio attachment arrives in a registered Discord channel, it is fetched from the CDN, transcribed offline, and delivered to the agent as `[Voice: <transcript>]`.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/transcription.ts` exists and `src/channels/discord.ts` imports `transcribeAudioBuffer`. If both are true, skip to Phase 3 (Configure).

### Check prerequisites

**Required skills:**
- Discord channel must be installed first (`discord` channel merged)

**System dependencies:**
- `whisper-cli` and `ffmpeg` installed on the host machine
- Whisper model file present at `data/models/ggml-base.bin`

Verify system dependencies:

```bash
which whisper-cli   # must print a path
which ffmpeg        # must print a path
ls data/models/ggml-base.bin  # must exist
```

If `whisper-cli` or `ffmpeg` are missing, install them:

```bash
brew install whisper-cpp ffmpeg
```

If the model file is missing, download it (~142 MB):

```bash
mkdir -p data/models
curl -L -o data/models/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

## Phase 2: Apply Code Changes

### Ensure Discord fork remote

```bash
git remote -v
```

If `discord` is missing, add it:

```bash
git remote add discord https://github.com/qwibitai/nanoclaw-discord.git
```

### Merge the skill branch

```bash
git fetch discord skill/voice-transcription
git merge discord/skill/voice-transcription || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/transcription.ts` (channel-agnostic `transcribeAudioBuffer` using whisper.cpp)
- Audio attachment handling in `src/channels/discord.ts` (fetch from CDN → transcribe → deliver)
- Voice transcription tests in `src/channels/discord.test.ts` (3 test cases: success, null, fetch failure)

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/discord.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

1. Restart the service:
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
   # Linux: systemctl --user restart nanoclaw
   ```

## Phase 4: Verify

### Test with a voice memo

Send a voice memo or audio file in any registered Discord channel. The agent should receive it as `[Voice: <transcript>]` and respond to its content.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i voice
```

Look for:
- `Discord message stored` — message with voice transcript delivered
- `Discord audio transcription failed` — fetch or whisper error

## Troubleshooting

- **Audio shows `[Voice Message - transcription unavailable]`**: The transcript was null — whisper.cpp returned empty output. Check: `WHISPER_MODEL` env var points to a valid `.bin` model file, `whisper-cli` is in PATH, `ffmpeg` is installed.
- **Audio shows `[Voice Message - transcription failed]`**: Fetch from Discord CDN failed or an exception was thrown. Check network connectivity and logs.
- **WhatsApp voice transcription broke**: The `transcribeAudioBuffer` function is channel-agnostic. If WhatsApp also uses it, the merge should be compatible. Check that the three-way merge preserved both codepaths.
