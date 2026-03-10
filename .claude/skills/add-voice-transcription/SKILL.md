---
name: add-voice-transcription
description: Add voice message transcription to NanoClaw using OpenAI's Whisper API. Automatically transcribes WhatsApp voice notes so the agent can read and respond to them.
---

# Add Voice Transcription

This skill adds automatic voice message transcription to NanoClaw's WhatsApp channel using OpenAI's Whisper API. When a voice note arrives, it is downloaded, transcribed, and delivered to the agent as `[Voice: <transcript>]`.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/transcription.ts` exists. If it does, skip to Phase 3 (Configure). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect information:

AskUserQuestion: Do you have an OpenAI API key for Whisper transcription?

If yes, collect it now. If no, direct them to create one at https://platform.openai.com/api-keys.

## Phase 2: Apply Code Changes

**Prerequisite:** WhatsApp must be installed first (`skill/whatsapp` merged). This skill modifies WhatsApp channel files.

### Ensure WhatsApp fork remote

```bash
git remote -v
```

If `whatsapp` is missing, add it:

```bash
git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
```

### Merge the skill branch

```bash
git fetch whatsapp skill/voice-transcription
git merge whatsapp/skill/voice-transcription
```

This merges in:

- `src/transcription.ts` (voice transcription module using OpenAI Whisper)
- Voice handling in `src/channels/whatsapp.ts` (isVoiceMessage check, transcribeAudioMessage call)
- Transcription tests in `src/channels/whatsapp.test.ts`
- `openai` npm dependency in `package.json`
- `OPENAI_API_KEY` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install --legacy-peer-deps
npm run build
npx vitest run src/channels/whatsapp.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

### Get OpenAI API key (if needed)

If the user doesn't have an API key:

> I need you to create an OpenAI API key:
>
> 1. Go to https://platform.openai.com/api-keys
> 2. Click "Create new secret key"
> 3. Give it a name (e.g., "NanoClaw Transcription")
> 4. Copy the key (starts with `sk-`)
>
> Cost: ~$0.006 per minute of audio (~$0.003 per typical 30-second voice note)

Wait for the user to provide the key.

### Add to environment

Add to `.env`:

```bash
OPENAI_API_KEY=<their-key>
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test with a voice note

Tell the user:

> Send a voice note in any registered WhatsApp chat. The agent should receive it as `[Voice: <transcript>]` and respond to its content.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i voice
```

Look for:

- `Transcribed voice message` — successful transcription with character count
- `OPENAI_API_KEY not set` — key missing from `.env`
- `OpenAI transcription failed` — API error (check key validity, billing)
- `Failed to download audio message` — media download issue

## Troubleshooting

### Voice notes show "[Voice Message - transcription unavailable]"

1. Check `OPENAI_API_KEY` is set in `.env` AND synced to `data/env/env`
2. Verify key works: `curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | head -c 200`
3. Check OpenAI billing — Whisper requires a funded account

### Voice notes show "[Voice Message - transcription failed]"

Check logs for the specific error. Common causes:

- Network timeout — transient, will work on next message
- Invalid API key — regenerate at https://platform.openai.com/api-keys
- Rate limiting — wait and retry

### Agent doesn't respond to voice notes

Verify the chat is registered and the agent is running. Voice transcription only runs for registered groups.
