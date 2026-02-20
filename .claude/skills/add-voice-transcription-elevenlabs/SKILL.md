---
name: add-voice-transcription-elevenlabs
description: Add voice message transcription to NanoClaw using ElevenLabs Scribe v2. Automatically transcribes WhatsApp voice notes so the agent can read and respond to them.
---

# Add Voice Transcription (ElevenLabs)

This skill adds automatic voice message transcription to NanoClaw's WhatsApp channel using ElevenLabs' Scribe v2 speech-to-text model. When a voice note arrives, it is downloaded, transcribed, and delivered to the agent as `[Voice: <transcript>]`.

## Batch vs Realtime

ElevenLabs offers two speech-to-text modes:

- **Batch** (`POST /v1/speech-to-text`): Upload a complete audio file, receive the transcript. This is what this skill uses.
- **Realtime** (`wss://...`): WebSocket streaming for live microphone audio.

**This skill uses batch mode.** WhatsApp voice notes arrive as complete audio files — batch is the correct choice. Realtime mode is designed for live audio streams (e.g., microphone input) and adds unnecessary complexity (PCM conversion, WebSocket session management) with no benefit for pre-recorded files. Batch handles any number of files efficiently — whether it's 1 voice note or a burst of several arriving at once, each is processed as a simple HTTP request. Use batch when processing 2+ files; it's also fine for single files.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `voice-transcription-elevenlabs` is in `applied_skills`, skip to Phase 3 (Configure). The code changes are already in place.

### Ask the user

1. **Do they have an ElevenLabs API key?** If yes, collect it now. If no, they'll need to create one at https://elevenlabs.io/app/settings/api-keys.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-voice-transcription-elevenlabs
```

This deterministically:
- Adds `src/transcription.ts` (voice transcription module using ElevenLabs Scribe v2)
- Three-way merges voice handling into `src/channels/whatsapp.ts` (isVoiceMessage check, transcribeAudioMessage call)
- Three-way merges transcription tests into `src/channels/whatsapp.test.ts` (mock + 3 test cases)
- Installs the `@elevenlabs/elevenlabs-js` npm dependency
- Updates `.env.example` with `ELEVENLABS_API_KEY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/channels/whatsapp.ts.intent.md` — what changed and invariants for whatsapp.ts
- `modify/src/channels/whatsapp.test.ts.intent.md` — what changed for whatsapp.test.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the 3 new voice transcription tests) and build must be clean before proceeding.

## Phase 3: Configure

### Get ElevenLabs API key (if needed)

If the user doesn't have an API key:

> I need you to create an ElevenLabs API key:
>
> 1. Go to https://elevenlabs.io/app/settings/api-keys
> 2. Click "Create API Key"
> 3. Give it a name (e.g., "NanoClaw Transcription")
> 4. Copy the key
>
> Scribe v2 pricing: see https://elevenlabs.io/pricing for current speech-to-text rates.

Wait for the user to provide the key.

### Add to environment

Add to `.env`:

```bash
ELEVENLABS_API_KEY=<their-key>
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
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
- `ELEVENLABS_API_KEY not set` — key missing from `.env`
- `ElevenLabs transcription failed` — API error (check key validity, billing)
- `Failed to download audio message` — media download issue

## Troubleshooting

### Voice notes show "[Voice Message - transcription unavailable]"

1. Check `ELEVENLABS_API_KEY` is set in `.env` AND synced to `data/env/env`
2. Verify key works: `curl -s https://api.elevenlabs.io/v1/user -H "xi-api-key: $ELEVENLABS_API_KEY" | head -c 200`
3. Check ElevenLabs billing — Scribe v2 requires an active subscription or credits

### Voice notes show "[Voice Message - transcription failed]"

Check logs for the specific error. Common causes:
- Network timeout — transient, will work on next message
- Invalid API key — regenerate at https://elevenlabs.io/app/settings/api-keys
- Rate limiting — wait and retry

### Agent doesn't respond to voice notes

Verify the chat is registered and the agent is running. Voice transcription only runs for registered groups.
