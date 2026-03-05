# Skill: add-local-stt

Adds local voice message transcription to NanoClaw using a self-hosted Whisper server.
When a user sends a voice note (PTT), it is downloaded, transcribed locally, and delivered
to the agent as `[Sprachnachricht]: <transcript>`.

No cloud API keys required. All audio stays on your machine.

## Prerequisites

A local Whisper HTTP server must be running and accessible. Recommended setup:

```bash
# Run whisper-large-v3 via faster-whisper or whisper-asr-webservice
# Example with whisper-asr-webservice (Docker):
docker run -d -p 8083:9000 \
  -e ASR_MODEL=large-v3 \
  -e ASR_ENGINE=faster_whisper \
  onerahmet/openai-whisper-asr-webservice:latest

# The server must accept:
# POST /transcribe
#   multipart/form-data: file=<audio>, language=<lang>
# Returns: { "text": "..." }
```

**Important:** Use `whisper-large-v3`, NOT `distil-large-v3`.
The distil model ignores the language parameter and outputs English phonetic
matches for non-English speech (e.g. German "Hallo" → "Hello").

Set the `MODEL_PATH` env var if using a container with cached models:
```bash
MODEL_PATH=/app/models/whisper-large-v3
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_URL` | `http://localhost:8083` | Base URL of the Whisper server |

Add to your systemd service or `.env`:
```
WHISPER_URL=http://localhost:8083
```

## Implementation

### 1. Add constants to `src/channels/whatsapp.ts`

At the top of the file with other constants:
```typescript
const WHISPER_URL = process.env.WHISPER_URL || 'http://localhost:8083';
```

### 2. Add `transcribeAudio()` function to `src/channels/whatsapp.ts`

Add after the imports:
```typescript
async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  const ext = mimeType.includes('ogg') ? 'ogg' : 'mp4';
  const tmpFile = path.join('/tmp', `nanoclaw-stt-${Date.now()}.${ext}`);
  try {
    fs.writeFileSync(tmpFile, audioBuffer);
    const response = await new Promise<string>((resolve, reject) => {
      exec(
        `curl -s -X POST "${WHISPER_URL}/transcribe" -F "file=@${tmpFile}" -F "language=de" --max-time 30`,
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        },
      );
    });
    const data = JSON.parse(response) as { text?: string };
    return data.text?.trim() || null;
  } catch (err) {
    logger.warn({ err }, 'Whisper STT error');
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}
```

Note: Uses `curl` via `exec` with a temp file to avoid argument length limits with large audio buffers.
The `language=de` parameter forces German — change to your language or remove for auto-detection.

### 3. Add PTT handler in `messages.upsert` in `src/channels/whatsapp.ts`

In the message processing block, after extracting `content` from text/image messages,
add the audio transcription block:

```typescript
// Transcribe PTT/audio messages via Whisper STT
let isVoiceMessage = false;
if (!content && normalized.audioMessage) {
  const audioMsg = normalized.audioMessage;
  const isPtt = (audioMsg as Record<string, unknown>)?.ptt === true;
  isVoiceMessage = isPtt;
  try {
    const audioBuffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
    const mimeType = audioMsg?.mimetype || 'audio/ogg; codecs=opus';
    const transcribed = await transcribeAudio(audioBuffer, mimeType);
    if (transcribed) {
      content = transcribed;
    }
  } catch (err) {
    logger.warn({ err, chatJid }, 'Failed to download/transcribe audio');
  }
}
```

Set `is_voice_message` on the `NewMessage` object passed to `onMessage()`.

### 4. Add `is_voice_message` to types

In `src/types.ts`, add to the `NewMessage` interface:
```typescript
is_voice_message?: boolean;
```

### 5. Update CLAUDE.md files

Add to `groups/global/CLAUDE.md`:
```markdown
## Sprachnachrichten

Nachrichten die mit `[Sprachnachricht]:` beginnen sind automatisch transkribierte Sprachnachrichten.
Auf Sprachnachrichten antworte KURZ und GESPRÄCHSSPRACHLICH — keine Markdown-Formatierung, keine Listen, keine Headers.
```

### 6. Build and restart

```bash
npm run build
systemctl --user restart nanoclaw
```

## Language Configuration

To change the transcription language, modify the `language=de` parameter in the `curl` call.
Use ISO 639-1 codes: `en`, `de`, `fr`, `es`, etc. Remove the parameter entirely for auto-detection.

## Troubleshooting

- **Empty transcription**: Check if the Whisper server is running (`curl http://localhost:8083/transcribe`)
- **English output for non-English speech**: You are using distil-large-v3. Switch to large-v3.
- **Slow transcription**: Normal for large-v3 on CPU. Use a GPU or switch to a smaller model for faster results.
