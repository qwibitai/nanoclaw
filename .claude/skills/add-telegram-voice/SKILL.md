---
name: add-telegram-voice
description: Add local voice transcription to Telegram using whisper.cpp. Transcribes voice notes on-device so the agent receives text instead of placeholders. No cloud API, no cost. Requires the Telegram channel skill to be applied first.
---

# Add Telegram Voice Transcription

This skill adds local voice message transcription to NanoClaw's Telegram channel using whisper.cpp. When a voice note arrives, it is downloaded from Telegram's API, converted to WAV via ffmpeg, transcribed locally by whisper-cli, and delivered to the agent as `[Voice: <transcript>]`.

**No cloud API, no API key, no cost.** Runs entirely on-device.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `telegram-voice` is in `applied_skills`, skip to Phase 3 (Verify).

### Check prerequisites

The `telegram` skill must be applied first. Check `.nanoclaw/state.yaml` for `telegram` in `applied_skills`. If not present, run `/add-telegram` first.

### Check dependencies are installed

```bash
whisper-cli --help >/dev/null 2>&1 && echo "WHISPER_OK" || echo "WHISPER_MISSING"
ffmpeg -version >/dev/null 2>&1 && echo "FFMPEG_OK" || echo "FFMPEG_MISSING"
```

If missing:
- **macOS**: `brew install whisper-cpp ffmpeg`
- **Linux (Debian/Ubuntu)**: `sudo apt-get install -y ffmpeg`, then build whisper.cpp from source:

```bash
cd /tmp
git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build -DBUILD_SHARED_LIBS=OFF
cmake --build build --config Release -j$(nproc)
cp build/bin/whisper-cli ~/.local/bin/
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
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram-voice
```

This deterministically:
- Adds `src/transcription.ts` (channel-agnostic voice transcription module using whisper.cpp)
- Three-way merges voice handling into `src/channels/telegram.ts` (download, transcribe, deliver)
- Three-way merges transcription tests into `src/channels/telegram.test.ts` (mock + 5 test cases)
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/channels/telegram.ts.intent.md` — what changed and invariants for telegram.ts
- `modify/src/channels/telegram.test.ts.intent.md` — what changed for telegram.test.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the 5 new voice transcription tests) and build must be clean before proceeding.

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
If `~/.local/bin` is not in PATH, add `Environment="PATH=..."` to the service unit.

### Build and restart

```bash
npm run build
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

### Test

Send a voice note in any registered Telegram chat. The agent should receive it as `[Voice: <transcript>]`.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i -E "voice|transcri|whisper"
```

Look for:
- `Voice message transcribed` — successful transcription
- `Voice transcription failed` — check model path, ffmpeg, or PATH
- `Voice download/transcription failed` — Telegram file download issue

## Configuration

Environment variables (optional, set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_BIN` | `whisper-cli` | Path to whisper.cpp binary |
| `WHISPER_MODEL` | `data/models/ggml-base.bin` | Path to GGML model file |

## Troubleshooting

**"Voice transcription failed"**: Ensure both `whisper-cli` and `ffmpeg` are in PATH. The service uses a restricted PATH — see Phase 3 above. Test manually:
```bash
ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -f wav /tmp/test.wav -y
whisper-cli -m data/models/ggml-base.bin -f /tmp/test.wav --no-timestamps -nt
```

**"libwhisper.so.1: cannot open shared object file"**: The whisper-cli binary was built with shared libraries. Rebuild with `-DBUILD_SHARED_LIBS=OFF` (see Phase 1).

**Transcription works in dev but not as service**: The service PATH likely doesn't include the directory containing `whisper-cli`. See Phase 3 above.

**Slow transcription**: The base model processes ~30s of audio in <1s on modern hardware. If slower, check CPU usage.

**Wrong language**: whisper.cpp auto-detects language. To force a language, set `WHISPER_LANG` and modify `src/transcription.ts` to pass `-l $WHISPER_LANG`.
