---
name: use-local-whisper
description: Use when the user wants local voice transcription instead of OpenAI Whisper API. Supports two modes — whisper.cpp CLI (macOS/Apple Silicon) or any HTTP-based Whisper server (faster-whisper-server, whisper-asr-webservice, distil-whisper on vLLM, etc.). WhatsApp only for now. Requires voice-transcription skill to be applied first.
---

# Use Local Whisper

Switches voice transcription from OpenAI's Whisper API to a local Whisper backend. Two modes are supported:

| Mode | When to use |
|------|-------------|
| **whisper-cli** | macOS with Apple Silicon. Uses the whisper.cpp binary directly — no server needed. |
| **HTTP server** | Any OS with a GPU. Uses an HTTP endpoint (`POST /transcribe`). Works with faster-whisper-server, whisper-asr-webservice, distil-whisper on vLLM, or any server that accepts audio file uploads and returns `{ "text": "..." }`. |

Both modes run locally — no OpenAI API key, no external network calls, no per-request cost.

**Channel support:** Currently WhatsApp only. The transcription module (`src/transcription.ts`) uses Baileys types for audio download. Other channels (Telegram, Discord, etc.) would need their own audio-download logic before this skill can serve them.

**Note:** The Homebrew package is `whisper-cpp`, but the CLI binary it installs is `whisper-cli`.

## Prerequisites

- `voice-transcription` skill must be applied first (WhatsApp channel)

**For whisper-cli mode (macOS):**
- macOS with Apple Silicon (M1+) recommended
- `whisper-cpp` installed: `brew install whisper-cpp` (provides the `whisper-cli` binary)
- `ffmpeg` installed: `brew install ffmpeg`
- A GGML model file downloaded to `data/models/`

**For HTTP server mode:**
- A running Whisper HTTP server that accepts `POST /transcribe` with a multipart file upload and returns JSON `{ "text": "..." }`
- `WHISPER_URL` set in `.env` (e.g. `WHISPER_URL=http://localhost:8080`)
- No whisper-cli, ffmpeg, or model file needed — the server handles everything

## Phase 1: Pre-flight

### Determine mode

Check `.env` for `WHISPER_URL`:

```bash
grep '^WHISPER_URL=' .env 2>/dev/null && echo "HTTP_MODE" || echo "CLI_MODE"
```

### Check if already applied

Check if `src/transcription.ts` already has local whisper support:

```bash
grep -E 'whisper-cli|transcribeWithHttpServer|WHISPER_URL' src/transcription.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

### HTTP server mode: check server health

```bash
WHISPER_URL=$(grep '^WHISPER_URL=' .env | cut -d= -f2-)
curl -sf "${WHISPER_URL}/health" && echo "SERVER_OK" || curl -sf "${WHISPER_URL}/" && echo "SERVER_OK" || echo "SERVER_UNREACHABLE"
```

If unreachable, ask the user to start their Whisper server and confirm the URL.

### whisper-cli mode: check dependencies

```bash
whisper-cli --help >/dev/null 2>&1 && echo "WHISPER_OK" || echo "WHISPER_MISSING"
ffmpeg -version >/dev/null 2>&1 && echo "FFMPEG_OK" || echo "FFMPEG_MISSING"
```

If missing, install via Homebrew:
```bash
brew install whisper-cpp ffmpeg
```

### whisper-cli mode: check for model file

```bash
ls data/models/ggml-*.bin 2>/dev/null || echo "NO_MODEL"
```

If no model exists, download the base model (148MB, good balance of speed and accuracy):
```bash
mkdir -p data/models
curl -L -o data/models/ggml-base.bin "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
```

For better accuracy at the cost of speed, use `ggml-small.bin` (466MB) or `ggml-medium.bin` (1.5GB).

## Phase 2: Apply Code Changes

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
git fetch whatsapp skill/local-whisper
git merge whatsapp/skill/local-whisper || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This modifies `src/transcription.ts` to use the `whisper-cli` binary instead of the OpenAI API.

### Add HTTP server support

After the merge, modify `src/transcription.ts` to also support HTTP-based Whisper servers:

1. **Add a `transcribeWithHttpServer()` function** alongside the existing `transcribeWithWhisperCpp()`:

   - Accept the same `audioBuffer: Buffer` parameter
   - Write the buffer to a temp file (use `os.tmpdir()` + a unique name with `.ogg` extension)
   - Read `WHISPER_URL` from `process.env`
   - Build a `FormData` body with the audio file attached (use Node.js built-in `fetch` and `FormData` from `undici` or `node:buffer`)
   - `POST` to `${WHISPER_URL}/transcribe` with the multipart form body
   - If `WHISPER_LANG` is set, include it as a form field named `language`
   - Parse the JSON response and return `response.text.trim()`
   - Clean up the temp file in a `finally` block
   - On error, log `"HTTP whisper transcription failed"` and throw
   - No ffmpeg conversion needed — HTTP servers typically accept ogg/opus directly

2. **Modify `transcribeAudioMessage()`** to check for `WHISPER_URL` first:

   ```
   if (process.env.WHISPER_URL) {
     return transcribeWithHttpServer(audioBuffer);
   }
   return transcribeWithWhisperCpp(audioBuffer);
   ```

   This keeps the existing whisper-cli path completely untouched — HTTP mode only activates when `WHISPER_URL` is set.

### Validate

```bash
npm run build
```

## Phase 3: Verify

### HTTP server mode

Verify the server is reachable:
```bash
WHISPER_URL=$(grep '^WHISPER_URL=' .env | cut -d= -f2-)
curl -sf "${WHISPER_URL}/health" || curl -sf "${WHISPER_URL}/"
```

Generate a test audio file and transcribe via the server:
```bash
WHISPER_URL=$(grep '^WHISPER_URL=' .env | cut -d= -f2-)
ffmpeg -f lavfi -i "sine=frequency=440:duration=1" -ar 16000 -ac 1 /tmp/test-whisper.wav -y 2>/dev/null
curl -s -F "file=@/tmp/test-whisper.wav" "${WHISPER_URL}/transcribe"
```

If `ffmpeg` is not installed, skip the manual curl test — the voice message test below will verify end-to-end.

### whisper-cli mode: ensure launchd PATH includes Homebrew

The NanoClaw launchd service runs with a restricted PATH. `whisper-cli` and `ffmpeg` are in `/opt/homebrew/bin/` (Apple Silicon) or `/usr/local/bin/` (Intel), which may not be in the plist's PATH.

Check the current PATH:
```bash
grep -A1 'PATH' ~/Library/LaunchAgents/com.nanoclaw.plist
```

If `/opt/homebrew/bin` is missing, add it to the `<string>` value inside the `PATH` key in the plist. Then reload:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Build and restart

```bash
npm run build
```

On macOS (launchd):
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

On Linux (systemd):
```bash
systemctl --user restart nanoclaw
```

### Test

Send a voice note in any registered group. The agent should receive it as `[Voice: <transcript>]`.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i -E "voice|transcri|whisper"
```

Look for:
- `Transcribed voice message` — successful transcription
- `whisper.cpp transcription failed` — check model path, ffmpeg, or PATH (whisper-cli mode)
- `HTTP whisper transcription failed` — check server URL and connectivity (HTTP mode)

## Configuration

Environment variables (set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_URL` | *(unset)* | URL of HTTP Whisper server (e.g. `http://localhost:8080`). When set, enables HTTP mode and ignores `WHISPER_BIN`/`WHISPER_MODEL`. |
| `WHISPER_LANG` | *(auto-detect)* | Force transcription language (e.g. `en`, `de`). Passed as `-l` flag in CLI mode, or `language` form field in HTTP mode. |
| `WHISPER_BIN` | `whisper-cli` | Path to whisper.cpp binary (CLI mode only) |
| `WHISPER_MODEL` | `data/models/ggml-base.bin` | Path to GGML model file (CLI mode only) |

## Troubleshooting

### HTTP server mode

**"HTTP whisper transcription failed"**: Check that the server is running and the URL is correct:
```bash
WHISPER_URL=$(grep '^WHISPER_URL=' .env | cut -d= -f2-)
curl -v "${WHISPER_URL}/health"
```

**Server returns unexpected response format**: This skill expects the server to return `{ "text": "..." }` from `POST /transcribe`. Some servers use different endpoints or response shapes. Check your server's documentation and adjust `transcribeWithHttpServer()` if needed.

**Connection refused**: The server may not be running, or you may need to check the port. Common ports: 8080 (faster-whisper-server), 9000 (whisper-asr-webservice).

**Slow transcription over HTTP**: Check GPU utilization on the server host. If the server is CPU-only, consider switching to whisper-cli mode on Apple Silicon instead.

### whisper-cli mode

**"whisper.cpp transcription failed"**: Ensure both `whisper-cli` and `ffmpeg` are in PATH. The launchd service uses a restricted PATH — see Phase 3 above. Test manually:
```bash
ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -f wav /tmp/test.wav -y
whisper-cli -m data/models/ggml-base.bin -f /tmp/test.wav --no-timestamps -nt
```

**Transcription works in dev but not as service**: The launchd plist PATH likely doesn't include `/opt/homebrew/bin`. See "Ensure launchd PATH includes Homebrew" in Phase 3.

**Slow transcription**: The base model processes ~30s of audio in <1s on M1+. If slower, check CPU usage — another process may be competing.

**Wrong language**: whisper.cpp auto-detects language. Set `WHISPER_LANG` in `.env` to force a specific language.
