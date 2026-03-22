---
name: add-transcription
description: Add voice transcription support to NanoClaw. Channel-agnostic — works with any channel that provides audio buffers. Supports local whisper.cpp or OpenAI Whisper API.
---

# Add Transcription

Adds a channel-agnostic voice transcription module (`src/transcription.ts`). Any channel skill (Telegram, WhatsApp, Discord, etc.) can dynamically import this module to transcribe voice messages.

Two backends are supported:
- **Local** (default): Uses `whisper-cli` (whisper.cpp) + `ffmpeg`. No API key, no network, no cost.
- **API**: Uses OpenAI Whisper API. Requires `OPENAI_API_KEY`.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep 'export async function transcribe' src/transcription.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

### Ask which backend

Ask the user which transcription backend they want:

1. **Local (whisper.cpp)** — free, private, requires ffmpeg + whisper-cli + model download
2. **OpenAI Whisper API** — easy setup, requires API key, sends audio to OpenAI

Default to local if the user has no preference.

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git remote add transcribe https://github.com/qwibitai/nanoclaw.git
git fetch transcribe skill/transcribe
git merge transcribe/skill/transcribe
```

If the merge has conflicts, resolve them carefully:

- **package-lock.json**: Safe to use `git checkout --theirs package-lock.json` — `npm install` will regenerate it.
- **package.json**: Do NOT use `--theirs` — this drops dependencies from other installed skills (e.g. `grammy` from Telegram). Instead, manually resolve: keep all `dependencies` from both sides, accept the incoming version/metadata fields.
- **Other files** (e.g. `repo-tokens/badge.svg`, `.claude/skills/`): Safe to use `--theirs`.

After resolving, `git add` the resolved files and `git merge --continue`.

### Validate

```bash
npm install
npm run build
```

The `npm install` is important — it regenerates `package-lock.json` from the resolved `package.json` and ensures all dependencies from both sides are installed.

## Phase 3: Install Dependencies

### For local backend

#### Install ffmpeg

- **macOS**: `brew install ffmpeg`
- **Linux**: `sudo apt install ffmpeg`

#### Install whisper.cpp

- **macOS**: `brew install whisper-cpp` (provides `whisper-cli`)
- **Linux**: Build from source:
  ```bash
  cd /tmp && git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git
  cd whisper.cpp && cmake -B build && cmake --build build -j$(nproc)
  sudo cp build/bin/whisper-cli /usr/local/bin/
  sudo cp build/src/libwhisper.so build/ggml/src/libggml*.so /usr/local/lib/
  sudo ldconfig
  ```

#### Download a model

Ask the user which model they want:

| Model | Size | Accuracy | Speed |
|-------|------|----------|-------|
| tiny | 75MB | Low | Fastest |
| base | 147MB | Moderate | Fast |
| small | 466MB | Good | Moderate |
| medium | 1.5GB | Very good | Slower |
| large-v3 | 3.1GB | Best | Slowest |

Default to **base** for a good balance. Download:

```bash
mkdir -p data/models
curl -L -o data/models/ggml-{model}.bin "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin"
```

Set `WHISPER_MODEL` in `.env` if not using base:
```
WHISPER_MODEL=data/models/ggml-{model}.bin
```

### For API backend

Add to `.env`:
```
TRANSCRIPTION_BACKEND=api
OPENAI_API_KEY=sk-...
```

## Phase 4: Verify

### Build and restart

```bash
npm run build
```

Restart the service:
```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

### Test

Send a voice note in any registered group. Channels with transcription support should receive it as `[Voice: <transcript>]`.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i -E "voice|transcri|whisper"
```

## Configuration

Environment variables (set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `TRANSCRIPTION_BACKEND` | `local` | Backend: `local` or `api` |
| `WHISPER_BIN` | `whisper-cli` | Path to whisper.cpp binary (local only) |
| `WHISPER_MODEL` | `data/models/ggml-base.bin` | Path to GGML model file (local only) |
| `OPENAI_API_KEY` | — | OpenAI API key (api only) |

## Troubleshooting

**"whisper.cpp transcription failed"**: Ensure both `whisper-cli` and `ffmpeg` are in PATH. When running as a service, the PATH may be restricted — add the binary locations to the service unit's PATH.

**"OPENAI_API_KEY not set"**: Set the key in `.env` and ensure `TRANSCRIPTION_BACKEND=api`.

**Wrong language**: whisper.cpp auto-detects language. To force a language, set `WHISPER_LANG` env var and modify `src/transcription.ts` to pass `-l $WHISPER_LANG`.
