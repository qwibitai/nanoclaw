---
name: add-discord-voice-transcription
description: Add voice message transcription to NanoClaw's Discord channel using local whisper.cpp. When a user sends a voice memo or audio file, it is downloaded, transcribed offline, and delivered to the agent as `[Voice: <transcript>]`.
---

# Add Discord Voice Transcription

This skill adds audio transcription to NanoClaw's Discord channel using the same local whisper.cpp engine already used by WhatsApp. It works by extracting the channel-agnostic `transcribeAudioBuffer(buffer)` function from the transcription module so Discord can call it directly after fetching the audio URL, without any dependency on Baileys or WhatsApp.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `discord-voice-transcription` is in `applied_skills`, skip to Phase 3 (Verify).

### Check prerequisites

This skill requires:
- `discord` skill applied (for the Discord channel)
- `voice-transcription` skill applied (for the base transcription module)
- `use-local-whisper` skill applied (to use whisper.cpp instead of OpenAI)
- whisper-cli and ffmpeg installed on the host machine

Confirm all are present in `applied_skills`.

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
