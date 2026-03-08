---
name: use-local-whisper
description: Use when the user wants local voice transcription instead of OpenAI Whisper API. Switches to whisper.cpp running on-device. Supports WhatsApp and Telegram channels. Requires voice-transcription and telegram skills to be applied first.
---

# Use Local Whisper

Switches voice transcription from OpenAI's Whisper API to local whisper.cpp. Runs entirely on-device — no API key, no network, no cost.

**Channel support:** WhatsApp and Telegram. The transcription module exports a channel-agnostic `transcribeAudio(Buffer)` function that any channel can call. WhatsApp uses the existing `transcribeAudioMessage(WAMessage, WASocket)` wrapper. Telegram downloads voice files via the Bot API and passes the buffer directly.

**Note:** The Homebrew package is `whisper-cpp`, but the CLI binary it installs is `whisper-cli`.

## Prerequisites

- `voice-transcription` skill must be applied first (WhatsApp channel)
- `telegram` skill must be applied first (Telegram channel)
- `whisper-cpp` CLI installed (see platform-specific instructions below)
- `ffmpeg` installed
- A GGML model file downloaded to `data/models/`

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `use-local-whisper` is in `applied_skills`, skip to Phase 3 (Verify).

### Check dependencies are installed

```bash
whisper-cli --help >/dev/null 2>&1 && echo "WHISPER_OK" || echo "WHISPER_MISSING"
ffmpeg -version >/dev/null 2>&1 && echo "FFMPEG_OK" || echo "FFMPEG_MISSING"
```

If missing, install per platform:

**macOS:**
```bash
brew install whisper-cpp ffmpeg
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt-get install -y ffmpeg
```

Then build whisper.cpp from source with static linking:

```bash
cd /tmp
git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build -DBUILD_SHARED_LIBS=OFF
cmake --build build --config Release -j$(nproc)
sudo cp build/bin/whisper-cli /usr/local/bin/
rm -rf /tmp/whisper.cpp
```

**Important on Linux**: Build with `-DBUILD_SHARED_LIBS=OFF` to produce a statically-linked binary. Without this, `whisper-cli` will fail at runtime with `libwhisper.so.1: cannot open shared object file`.

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

This modifies:
- `src/transcription.ts` — replaces OpenAI API with whisper.cpp, adds channel-agnostic `transcribeAudio(Buffer)` export
- `src/channels/telegram.ts` — replaces voice placeholder with download + transcription handler
- `src/channels/telegram.test.ts` — adds transcription mock and 5 voice transcription tests

### Validate

```bash
npm test
npm run build
```

## Phase 3: Verify

### Ensure service PATH includes whisper-cli and ffmpeg

The NanoClaw service runs with a restricted PATH. Ensure `whisper-cli` and `ffmpeg` are accessible.

**macOS (launchd):**
```bash
grep -A1 'PATH' ~/Library/LaunchAgents/com.nanoclaw.plist
```
If `/opt/homebrew/bin` is missing, add it to the PATH in the plist, then reload.

**Linux (systemd):**
```bash
systemctl --user show nanoclaw | grep -i environment
```
If `~/.local/bin` or `/usr/local/bin` is not in PATH, add `Environment="PATH=..."` to the service unit.

### Build and restart

```bash
npm run build
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

### Test

Send a voice note in any registered WhatsApp or Telegram chat. The agent should receive it as `[Voice: <transcript>]`.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i -E "voice|transcri|whisper"
```

Look for:
- `Transcribed voice message` — successful transcription
- `whisper.cpp transcription failed` — check model path, ffmpeg, or PATH
- `Voice download/transcription failed` — Telegram file download issue

## Configuration

Environment variables (optional, set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_BIN` | `whisper-cli` | Path to whisper.cpp binary |
| `WHISPER_MODEL` | `data/models/ggml-base.bin` | Path to GGML model file |

## Troubleshooting

**"whisper.cpp transcription failed"**: Ensure both `whisper-cli` and `ffmpeg` are in PATH. The service uses a restricted PATH — see Phase 3 above. Test manually:
```bash
ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -f wav /tmp/test.wav -y
whisper-cli -m data/models/ggml-base.bin -f /tmp/test.wav --no-timestamps -nt
```

**"libwhisper.so.1: cannot open shared object file"**: The whisper-cli binary was built with shared libraries. Rebuild with `-DBUILD_SHARED_LIBS=OFF` (see Phase 1).

**Transcription works in dev but not as service**: The service PATH likely doesn't include the directory containing `whisper-cli`. See Phase 3 above.

**Slow transcription**: The base model processes ~30s of audio in <1s on modern hardware. If slower, check CPU usage.

**Wrong language**: whisper.cpp auto-detects language. To force a language, set `WHISPER_LANG` and modify `src/transcription.ts` to pass `-l $WHISPER_LANG`.
