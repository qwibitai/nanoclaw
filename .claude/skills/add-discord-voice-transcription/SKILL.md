---
name: add-discord-voice-transcription
description: Add voice message transcription to NanoClaw's Discord (and any other Chat SDK-bridged) channel using local whisper.cpp. When a user sends a voice memo or audio file, it is transcribed offline and delivered to the agent inline as `[Voice: <transcript>]`.
---

# Add Discord Voice Transcription

Adds automatic voice message transcription to Discord (and, since the hook is in the shared Chat SDK bridge, any other channel that goes through it — Slack, Teams, Webex, Google Chat, etc.). Audio attachments are transcribed with [whisper.cpp](https://github.com/ggerganov/whisper.cpp) on the host, and the transcript is appended to the inbound message content as `[Voice: <transcript>]` so the agent sees it as plain text alongside the audio file placeholder.

No cloud API, no `OPENAI_API_KEY` — transcription is fully on-device.

Sibling skill: `/add-voice-transcription-free-whisper` (PR #2317) covers Signal/Telegram/WhatsApp via per-adapter patches. This skill complements it by covering Chat SDK-bridged channels in one shared hook.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/transcription.ts` exists and `src/channels/chat-sdk-bridge.ts` imports `transcribeAudioBuffer`. If both are true, skip to Phase 3 (Configure).

### Ask the user

Use `AskUserQuestion`:

> Do you want to install whisper.cpp and ffmpeg now, or have you already done that?

If they need help, walk them through the install in Phase 2 step 1.

## Phase 2: Apply Code Changes

**Prerequisite:** Discord channel must be installed first (`skill/discord` merged). This skill hooks into the Chat SDK bridge that Discord uses.

### 1. Install host dependencies

`whisper-cli` (from whisper.cpp) and `ffmpeg`:

**macOS:**

```bash
brew install whisper-cpp ffmpeg
```

**Debian / Ubuntu:**

```bash
sudo apt-get install -y ffmpeg
# whisper.cpp: build from https://github.com/ggerganov/whisper.cpp
```

### 2. Download a model

```bash
mkdir -p data/models
curl -L -o data/models/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

Other sizes: `ggml-tiny.bin` (~75 MB, faster, lower quality), `ggml-small.bin` (~466 MB), `ggml-medium.bin` (~1.5 GB), `ggml-large-v3.bin` (~3 GB).

### 3. Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/nanocoai/nanoclaw.git
```

### 4. Merge the skill branch

```bash
git fetch upstream skill/discord-voice-transcription
git merge upstream/skill/discord-voice-transcription || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:

- `src/transcription.ts` — `transcribeAudioBuffer(Buffer)` + `isAudioAttachment(att)` helpers (channel-agnostic, shells out to ffmpeg + whisper-cli)
- `src/transcription.test.ts` — 8 unit tests covering env-gate, trim, empty-output, and failure paths
- Voice transcription hook in `src/channels/chat-sdk-bridge.ts` (15 lines, gated on `WHISPER_BIN`)

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### 5. Validate

```bash
pnpm install
pnpm run build
npx vitest run src/transcription.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

Add to `.env`:

```bash
# Required: path to (or name of) the whisper.cpp binary on PATH
WHISPER_BIN=whisper-cli

# Optional: model file. Defaults to data/models/ggml-base.bin relative to cwd.
# WHISPER_MODEL=/absolute/path/to/ggml-base.bin
```

Sync to container env:

```bash
mkdir -p data/env && cp .env data/env/env
```

The transcription itself runs on the host — no whisper binary is needed inside the agent container.

### Restart

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Phase 4: Verify

See [VERIFY.md](VERIFY.md). Send a voice memo to Discord; the agent should receive `[Voice: <transcript>]` inline alongside the audio file placeholder.

## How it works

1. Discord (or any Chat SDK-bridged channel) delivers a message with an audio attachment.
2. `chat-sdk-bridge.ts` downloads the attachment via the adapter's `fetchData()`.
3. If `WHISPER_BIN` is set **and** the attachment looks like audio (`mimeType: 'audio/*'` or coarse `type: 'audio'`/`'voice'`), the bridge calls `transcribeAudioBuffer(buffer)`:
   - Writes the buffer to a temp file
   - Runs `ffmpeg` to convert to 16 kHz mono WAV
   - Runs `whisper-cli` with the configured model
   - Returns the trimmed transcript (or `null` on failure)
4. The transcript is appended to the inbound message content as `[Voice: <transcript>]`. The agent sees this inline alongside the existing `[audio: voice.ogg — saved to /workspace/inbox/...]` attachment placeholder, so Claude has both the transcript text **and** the original audio file available.

When `WHISPER_BIN` is unset, the hook is a no-op — fully opt-in, zero overhead.

## Troubleshooting

### Voice messages still arrive as plain audio placeholders, no transcript

1. Confirm `WHISPER_BIN` is set in `.env` **and** synced to `data/env/env`:
   ```bash
   grep WHISPER data/env/env
   ```
2. Confirm the binary exists on PATH (or at the configured absolute path):
   ```bash
   "$WHISPER_BIN" --help 2>&1 | head -5
   ```
3. Confirm the model file exists:
   ```bash
   ls -lh "${WHISPER_MODEL:-data/models/ggml-base.bin}"
   ```
4. Tail logs for the failure path:
   ```bash
   tail logs/nanoclaw.log | grep -i "Voice transcription"
   ```

### Transcription is slow

Whisper model size dominates latency. On Apple Silicon, `whisper.cpp` builds with Metal acceleration enabled by default and is roughly real-time on `base`. On x86_64 CPU-only, expect ~5–15 s per minute of audio with `base`. Drop to `tiny` for snappier (and lower-quality) results, or step up to `small`/`medium` for better quality.

### whisper-cli not found

Install it (`brew install whisper-cpp` on macOS) or set `WHISPER_BIN` to an absolute path:

```bash
WHISPER_BIN=/Users/you/whisper.cpp/build/bin/whisper-cli
```
