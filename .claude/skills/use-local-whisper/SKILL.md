---
name: use-local-whisper
description: Use when the user wants local voice transcription instead of OpenAI Whisper API. Switches to whisper.cpp running on Apple Silicon. Requires voice-transcription skill to be applied first.
---

# Use Local Whisper

Switches voice transcription from OpenAI's Whisper API to local whisper.cpp. Runs entirely on-device — no API key, no network, no cost.

**Note:** The Homebrew package is `whisper-cpp`, but the CLI binary it installs is `whisper-cli`.

## Prerequisites

- `voice-transcription` skill must be applied first
- macOS with Apple Silicon (M1+) recommended
- `whisper-cpp` installed: `brew install whisper-cpp` (provides the `whisper-cli` binary)
- `ffmpeg` installed: `brew install ffmpeg`
- A GGML model file downloaded to `data/models/`

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `use-local-whisper` is in `applied_skills`, skip to Phase 3 (Verify).

### Check dependencies are installed

```bash
whisper-cli --help >/dev/null 2>&1 && echo "WHISPER_OK" || echo "WHISPER_MISSING"
ffmpeg -version >/dev/null 2>&1 && echo "FFMPEG_OK" || echo "FFMPEG_MISSING"
```

If missing, install via Homebrew:
```bash
brew install whisper-cpp ffmpeg
```

### Check for model file

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

```bash
npx tsx scripts/apply-skill.ts .claude/skills/use-local-whisper
```

This modifies `src/transcription.ts` to use the `whisper-cli` binary instead of the OpenAI API.

### Validate

```bash
npm test
npm run build
```

## Phase 3: Verify

### Ensure launchd PATH includes Homebrew

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
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Test

Send a voice note in any registered group. The agent should receive it as `[Voice: <transcript>]`.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i -E "voice|transcri|whisper"
```

Look for:
- `Transcribed voice message` — successful transcription
- `whisper.cpp transcription failed` — check model path, ffmpeg, or PATH

## Configuration

Environment variables (optional, set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_BIN` | `whisper-cli` | Path to whisper.cpp binary |
| `WHISPER_MODEL` | `data/models/ggml-base.bin` | Path to GGML model file |

## Troubleshooting

**"whisper.cpp transcription failed"**: Ensure both `whisper-cli` and `ffmpeg` are in PATH. The launchd service uses a restricted PATH — see Phase 3 above. Test manually:
```bash
ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -f wav /tmp/test.wav -y
whisper-cli -m data/models/ggml-base.bin -f /tmp/test.wav --no-timestamps -nt
```

**Transcription works in dev but not as service**: The launchd plist PATH likely doesn't include `/opt/homebrew/bin`. See "Ensure launchd PATH includes Homebrew" in Phase 3.

**Slow transcription**: The base model processes ~30s of audio in <1s on M1+. If slower, check CPU usage — another process may be competing.

**Wrong language**: whisper.cpp auto-detects language. To force a language, you can set `WHISPER_LANG` and modify `src/transcription.ts` to pass `-l $WHISPER_LANG`.
