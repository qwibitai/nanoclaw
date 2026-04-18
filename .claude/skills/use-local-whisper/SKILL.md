---
name: use-local-whisper
description: Use when the user wants local voice transcription instead of OpenAI Whisper API. Switches to whisper.cpp running locally. Works for Telegram and WhatsApp channels. No API key, no network, no cost.
---

# Use Local Whisper

Switches voice transcription from OpenAI's Whisper API to local whisper.cpp. Runs entirely on-device — no API key, no network, no cost.

**Channel support:** Telegram and WhatsApp. The transcription module (`src/transcription.ts`) exposes a generic `transcribeAudioBuffer(buffer, filename)` API — any channel that downloads audio can use it.

## Prerequisites

- `src/transcription.ts` must exist (created by the voice transcription feature)
- `whisper-cli` binary installed and in PATH
- `ffmpeg` installed
- A GGML model file at `data/models/ggml-base.bin` (or configured via `WHISPER_MODEL`)

## Phase 1: Pre-flight

### Check if already applied

```bash
grep 'whisper-cli' src/transcription.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

### Check dependencies

```bash
whisper-cli --help >/dev/null 2>&1 && echo "WHISPER_OK" || echo "WHISPER_MISSING"
ffmpeg -version >/dev/null 2>&1 && echo "FFMPEG_OK" || echo "FFMPEG_MISSING"
ls data/models/ggml-*.bin 2>/dev/null || echo "NO_MODEL"
```

## Phase 2: Install Dependencies

### macOS (Apple Silicon)

```bash
brew install whisper-cpp ffmpeg
```

The Homebrew package is `whisper-cpp` but the binary is `whisper-cli`.

### Linux (Debian/Ubuntu)

```bash
# System packages
sudo apt-get install -y ffmpeg build-essential cmake

# Build whisper.cpp from source
git clone https://github.com/ggml-org/whisper.cpp.git --depth=1 /tmp/whisper.cpp
cd /tmp/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(nproc)

# Install binary (adjust destination to a directory in PATH)
cp build/bin/whisper-cli ~/.local/bin/whisper-cli
chmod +x ~/.local/bin/whisper-cli
```

### Download model

```bash
mkdir -p data/models
curl -L -o data/models/ggml-base.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
```

For better accuracy at the cost of speed: `ggml-small.bin` (466MB) or `ggml-medium.bin` (1.5GB).

## Phase 3: Apply Code Changes

Replace `src/transcription.ts` with the whisper.cpp implementation:

```typescript
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');

export async function transcribeAudioBuffer(
  buffer: Buffer,
  filename: string,
): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}`;
  const ext = path.extname(filename) || '.ogg';
  const tmpIn = path.join(tmpDir, `${id}${ext}`);
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    fs.writeFileSync(tmpIn, buffer);

    await execFileAsync(
      'ffmpeg',
      ['-i', tmpIn, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
      { timeout: 30_000 },
    );

    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', tmpWav, '--no-timestamps', '-nt'],
      { timeout: 60_000 },
    );

    const transcript = stdout.trim();
    if (!transcript) return null;

    logger.info(
      { bin: WHISPER_BIN, model: WHISPER_MODEL, chars: transcript.length },
      'whisper.cpp transcription complete',
    );
    return transcript;
  } catch (err) {
    logger.error({ err }, 'whisper.cpp transcription failed');
    return null;
  } finally {
    for (const f of [tmpIn, tmpWav]) {
      try { fs.unlinkSync(f); } catch { /* best-effort cleanup */ }
    }
  }
}
```

Then build:

```bash
npm run build
```

## Phase 4: Configure PATH (if needed)

The nanoclaw service may run with a restricted PATH. Verify `whisper-cli` is reachable:

```bash
which whisper-cli
```

If not found, set `WHISPER_BIN` in `.env` to the absolute path:

```
WHISPER_BIN=/home/youruser/.local/bin/whisper-cli
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

**macOS launchd only:** If using launchd, add `/opt/homebrew/bin` to the PATH key in the plist, then reload:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Phase 5: Build and Restart

```bash
npm run build
# Linux (systemd):
kill -TERM $(pgrep -f "nanoclaw/dist/index.js")   # systemd Restart=always brings it back
# macOS (launchd):
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 6: Verify

Send a voice message to any registered chat. The agent should receive it as `[Voice: <transcript>]`.

Check logs:
```bash
tail -f logs/nanoclaw.log | grep -i -E "voice|transcri|whisper"
```

- `whisper.cpp transcription complete` — success
- `whisper.cpp transcription failed` — check PATH, model path, ffmpeg

## Troubleshooting

**"whisper.cpp transcription failed"**
- Verify both `whisper-cli` and `ffmpeg` are in PATH (or set `WHISPER_BIN` in `.env`)
- Test manually:
  ```bash
  ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -f wav /tmp/test.wav -y
  whisper-cli -m data/models/ggml-base.bin -f /tmp/test.wav --no-timestamps -nt
  ```

**Falls back to `[Voice message] (/path/to/file.oga)` instead of transcribing**
- Transcription returned null — check the above test
- Check `WHISPER_MODEL` path exists: `ls data/models/ggml-base.bin`

**Slow transcription**
- The base model processes ~30s of audio in <1s on Apple Silicon, ~5s on x86_64
- Use `ggml-small.bin` only if accuracy is insufficient — speed tradeoff

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_BIN` | `whisper-cli` | Path to whisper.cpp binary |
| `WHISPER_MODEL` | `data/models/ggml-base.bin` | Path to GGML model file |
