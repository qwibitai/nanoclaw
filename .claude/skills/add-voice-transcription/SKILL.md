---
name: add-voice-transcription
description: Add voice message transcription to NanoClaw using OpenAI Whisper API. Works with any channel (WhatsApp, Telegram, etc.).
---

# Add Voice Transcription

Adds automatic voice/audio transcription via OpenAI's Whisper API. Runs inside the container as a media handler — intercepts voice/audio files, calls the API, and delivers the transcript to Claude as text. Channel-agnostic.

Cost: ~$0.006 per minute of audio.

## Phase 1: Pre-flight

Check if already applied:

```bash
test -f container/handlers/voice-openai.js && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 2 (Configure).

## Phase 2: Apply

### Merge the skill branch

```bash
git fetch upstream skill/voice-transcription
git merge upstream/skill/voice-transcription || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

### Configure API key

Ask the user for their OpenAI API key. If they don't have one, direct them to https://platform.openai.com/api-keys.

Add to `.env`:

```
OPENAI_API_KEY=<their-key>
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

Verify that `src/container-runner.ts` passes `OPENAI_API_KEY` into containers. Look for this in `buildContainerArgs()`:

```typescript
const envSecrets = readEnvFile(['OPENAI_API_KEY']);
if (envSecrets.OPENAI_API_KEY) {
  args.push('-e', `OPENAI_API_KEY=${envSecrets.OPENAI_API_KEY}`);
}
```

If not present, add it alongside the other `-e` env flags.

### Build and restart

```bash
npm run build
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Verify

Tell the user:

> Send a voice note in any registered chat. The agent should respond to the spoken content.

### Check logs

```bash
tail -f logs/nanoclaw.log
```

In the container logs, look for:
- `Content handler registered for type="voice" priority=50` — handler loaded
- `[Voice transcript]:` — transcription succeeded

## Troubleshooting

**Voice notes not transcribed**
1. Check `OPENAI_API_KEY` is set in `.env` and synced to `data/env/env`
2. Verify key works: `curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | head -c 200`
3. Check OpenAI billing — Whisper requires a funded account

**Agent receives `[Voice message: media/...]` instead of transcript**
The handler failed or wasn't loaded. Check container logs for errors.
