---
name: add-telegram-voice-transcription
description: Add voice message transcription to Telegram channel using a local Whisper transcription service. Triggers on "telegram voice", "voice transcription", "transcribe voice".
---

# Add Telegram Voice Transcription

This skill adds automatic voice message transcription to NanoClaw's Telegram channel using a local Whisper transcription service. When a voice message arrives, it is downloaded from the Telegram API, sent to the local transcription service, and delivered to the agent as `[Voice message]: <transcript>`.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `add-telegram-voice-transcription` is in `applied_skills`, skip to Phase 3 (Configure). The code changes are already in place.

Also check if `src/channels/telegram.ts` already contains `transcribeVoice`. If it does, the changes are already applied.

### Requirements

- `TELEGRAM_BOT_TOKEN` must be set in `.env` (Telegram channel must be configured)
- A local Whisper transcription service must be running (default: `http://localhost:8765`)
- The transcription service must expose `POST /api/transcribe-sync` (multipart form, field `file`) returning `{"text": "transcript"}`
- Health check at `GET /health` returning `{"status": "ok"}`

### Setting up the transcription service

The recommended service is [local_video_transcriber](https://github.com/Jimbo1167/local_video_transcriber), which runs faster-whisper locally.

**With Docker:**
```bash
git clone https://github.com/Jimbo1167/local_video_transcriber.git
cd local_video_transcriber
docker compose up -d
```
The service will be available at `http://localhost:8000`. Set `TRANSCRIPTION_URL=http://localhost:8000` in `.env` if using the default Docker port.

**Without Docker:**
```bash
git clone https://github.com/Jimbo1167/local_video_transcriber.git
cd local_video_transcriber
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python scripts/model_server.py --host 0.0.0.0 --port 8765
```

The first startup downloads the Whisper model (~1.5GB) and takes a few minutes. Subsequent starts are fast.

Any service implementing the same API (`POST /api/transcribe-sync` returning `{"text": "..."}` and `GET /health`) will work.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram-voice-transcription
```

This deterministically:
- Adds `transcribeVoice()` helper function to `src/channels/telegram.ts`
- Adds `TRANSCRIPTION_URL` constant to `src/channels/telegram.ts`
- Replaces the voice message placeholder handler with a full transcription handler
- Adds a transcription service health check in the `connect()` method

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/telegram.ts.intent.md` — what changed and invariants

### Validate

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Configure

### Transcription service URL

Optionally set `TRANSCRIPTION_URL` in `.env` if the transcription service is not at the default address:

```bash
TRANSCRIPTION_URL=http://localhost:8765
```

The default is `http://localhost:8765` and does not need to be set unless the service runs elsewhere.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test with a voice message

Tell the user:

> Send a voice message in any registered Telegram chat. The agent should receive it as `[Voice message]: <transcript>` and respond to its content.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i voice
```

Look for:
- `Voice message processed` with `transcribed: true` — successful transcription
- `Transcription service returned error` — service returned non-OK HTTP status
- `Voice transcription failed` — network or timeout error
- `Voice message download/transcription failed` — Telegram file download failed
- `Transcription service is not reachable` — health check failed at startup (warning only)

## Troubleshooting

### Voice messages show "[Voice message -- transcription unavailable]"

1. Check the transcription service is running: `curl http://localhost:8765/health`
2. Check `TRANSCRIPTION_URL` in `.env` matches the actual service address
3. Restart NanoClaw after changing `.env`

### Transcription service health check warning at startup

This is non-blocking. The bot will still start and attempt transcription when voice messages arrive. The service may have started after NanoClaw.

### Transcription takes too long

The handler has a 2-minute timeout. If transcriptions consistently time out, check the service's resource usage and consider running it on a faster machine or with a smaller Whisper model.

### Agent doesn't respond to voice messages

Verify the chat is registered and the agent is running. Voice transcription only runs for registered groups (same as all other message types).

## Removal

1. Revert `src/channels/telegram.ts` to restore the original voice handler line: `this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));`
2. Remove the `transcribeVoice` function and `TRANSCRIPTION_URL` constant
3. Remove `TRANSCRIPTION_URL` from `.env` (if set)
4. Remove `add-telegram-voice-transcription` from `.nanoclaw/state.yaml`
5. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
