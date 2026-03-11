---
name: add-discord-voice-transcription
description: Add voice message transcription to NanoClaw's Discord channel using local whisper.cpp. When a user sends a voice memo or audio file, it is downloaded, transcribed offline, and delivered to the agent as `[Voice: <transcript>]`.
---

# Add Discord Voice Transcription

This skill adds audio transcription to NanoClaw's Discord channel using local whisper.cpp. It exposes a channel-agnostic `transcribeAudioBuffer(buffer)` function from the transcription module so Discord can call it directly after fetching the audio URL, without any dependency on Baileys or WhatsApp.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `discord-voice-transcription` is in `applied_skills`, skip to Phase 3 (Verify).

### Check prerequisites

This skill requires:
- `discord` skill applied (for the Discord channel)
- `voice-transcription` skill applied (for the base transcription module)
- `whisper-cli` and `ffmpeg` installed on the host machine
- Whisper model file present at `data/models/ggml-base.bin`

**Note:** This skill modifies `src/transcription.ts` to use local whisper.cpp and expose `transcribeAudioBuffer`. If you previously applied `use-local-whisper`, the changes are compatible. If not, this skill switches the transcription backend from OpenAI to whisper.cpp.

Confirm the skills are present in `applied_skills`, then verify the system dependencies:

```bash
which whisper-cli   # must print a path
which ffmpeg        # must print a path
ls data/models/ggml-base.bin  # must exist
```

If `whisper-cli` or `ffmpeg` are missing, install them:

```bash
brew install whisper-cpp ffmpeg
```

If the model file is missing, download it (≈142 MB):

```bash
mkdir -p data/models
curl -L -o data/models/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

## Phase 2: Apply Code Changes

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-discord-voice-transcription
```

This deterministically:
- Three-way merges `transcribeAudioBuffer` export into `src/transcription.ts` (the inner whisper logic becomes a public, channel-agnostic export)
- Three-way merges audio handling into `src/channels/discord.ts` (fetch → transcribeAudioBuffer, with fallbacks)
- Three-way merges audio tests into `src/channels/discord.test.ts` (transcribeAudioBuffer mock, 3 test cases)
- Records the application in `.nanoclaw/state.yaml`

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean.

## Phase 3: Verify

### Test with a voice memo

Send a voice memo or audio file in any registered Discord channel. The agent should receive it as `[Voice: <transcript>]` and be able to respond to its content.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i voice
```

Look for:
- `Discord message stored` — message with voice transcript delivered
- `Discord audio transcription failed` — fetch or whisper error

## Troubleshooting

### Audio shows `[Voice Message - transcription unavailable]`

The transcript was null — whisper.cpp returned empty output. Check:
- `WHISPER_MODEL` env var points to a valid `.bin` model file
- `whisper-cli` is in PATH: `which whisper-cli`
- `ffmpeg` is installed: `which ffmpeg`

### Audio shows `[Voice Message - transcription failed]`

Fetch from Discord CDN failed or an exception was thrown. Check network connectivity and logs.

### WhatsApp voice transcription broke

The `transcribeAudioMessage` public API is unchanged. If WhatsApp tests fail, check that the three-way merge preserved the original download + fallback logic in `transcribeAudioMessage`.
