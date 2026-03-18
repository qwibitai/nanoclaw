---
name: add-local-voice
description: Add local voice transcription to NanoClaw using whisper.cpp. Runs entirely on-device — no API key, no network, no cost. Detects installed channels (Telegram, WhatsApp) and patches each automatically.
---

# Add Local Voice Transcription

Adds voice message transcription using whisper.cpp running locally. No API key required, no per-request cost.

**Supported channels:** Telegram, WhatsApp. Detects which are installed and patches each automatically.

## Prerequisites

- `whisper-cli` binary installed (see Phase 1)
- `ffmpeg` installed
- A GGML model file in `data/models/`

## Phase 1: Install Dependencies

### Check what's already present

```bash
whisper-cli --help >/dev/null 2>&1 && echo "WHISPER_OK" || echo "WHISPER_MISSING"
ffmpeg -version >/dev/null 2>&1 && echo "FFMPEG_OK" || echo "FFMPEG_MISSING"
ls data/models/ggml-*.bin 2>/dev/null || echo "NO_MODEL"
```

### Install whisper-cli

**macOS (Homebrew):**

```bash
brew install whisper-cpp ffmpeg
```

The Homebrew package is `whisper-cpp` but installs the binary as `whisper-cli`.

**Linux (build from source):**

```bash
sudo apt-get install -y ffmpeg build-essential cmake
cd /tmp
git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git whisper-build
cd whisper-build
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(nproc)
mkdir -p ~/.local/bin
cp build/bin/whisper-cli ~/.local/bin/whisper-cli
```

### Download a model

```bash
mkdir -p data/models
curl -L -o data/models/ggml-base.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
```

Available models (speed vs accuracy tradeoff):

| Model | Size | Notes |
|-------|------|-------|
| `ggml-base.bin` | 148MB | Good default, fast on CPU |
| `ggml-small.bin` | 466MB | Better accuracy |
| `ggml-medium.bin` | 1.5GB | High accuracy, slower |

## Phase 2: Add src/transcription.ts

Check if already present:

```bash
grep -q 'transcribeAudioBuffer' src/transcription.ts 2>/dev/null && echo "EXISTS" || echo "MISSING"
```

If missing, create `src/transcription.ts`:

```typescript
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');

/**
 * Transcribe an audio buffer using whisper.cpp.
 * Accepts any format ffmpeg can decode (ogg, opus, mp4, wav, etc.).
 * Returns the transcript string, or null on failure.
 */
export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}`;
  const tmpAudio = path.join(tmpDir, `${id}.ogg`);
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    fs.writeFileSync(tmpAudio, audioBuffer);

    // Convert to 16kHz mono WAV (required by whisper.cpp)
    await execFileAsync(
      'ffmpeg',
      ['-i', tmpAudio, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
      { timeout: 30_000 },
    );

    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      ['-m', WHISPER_MODEL, '-f', tmpWav, '--no-timestamps', '-nt'],
      { timeout: 60_000 },
    );

    const transcript = stdout.trim();
    return transcript || null;
  } catch (err) {
    console.error('whisper.cpp transcription failed:', err);
    return null;
  } finally {
    for (const f of [tmpAudio, tmpWav]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort cleanup */
      }
    }
  }
}
```

## Phase 3: Patch Installed Channels

### Telegram

Check if installed and patched:

```bash
test -f src/channels/telegram.ts && echo "INSTALLED" || echo "NOT_INSTALLED"
grep -q 'transcribeAudioBuffer' src/channels/telegram.ts 2>/dev/null && echo "PATCHED" || echo "NOT_PATCHED"
```

If installed but not patched:

1. Add import at the top of `src/channels/telegram.ts` (with other imports):

```typescript
import { transcribeAudioBuffer } from '../transcription.js';
```

2. Find the `message:voice` handler — it will have a `storeNonText(ctx, '[Voice message]')` call. Replace the entire handler with:

```typescript
this.bot.on('message:voice', async (ctx) => {
  const chatJid = `tg:${ctx.chat.id}`;
  const group = this.opts.registeredGroups()[chatJid];
  if (!group) return;

  let placeholder = '[Voice message]';
  try {
    const file = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const transcript = await transcribeAudioBuffer(buffer);
    if (transcript) placeholder = `[Voice: ${transcript}]`;
  } catch (err) {
    logger.debug({ err }, 'Voice transcription failed, using placeholder');
  }

  storeNonText(ctx, placeholder);
});
```

### WhatsApp

Check if installed and patched:

```bash
test -f src/channels/whatsapp.ts && echo "INSTALLED" || echo "NOT_INSTALLED"
grep -q 'transcribeAudioBuffer' src/channels/whatsapp.ts 2>/dev/null && echo "PATCHED" || echo "NOT_PATCHED"
```

If installed but not patched:

1. Add import at the top of `src/channels/whatsapp.ts`:

```typescript
import { transcribeAudioBuffer } from '../transcription.js';
```

2. Find the voice/audio message handler — search for the placeholder:

```bash
grep -n "Voice message" src/channels/whatsapp.ts
```

3. Before the `[Voice message]` placeholder, download the audio buffer via Baileys and call transcription:

```typescript
import { downloadMediaMessage } from '@whiskeysockets/baileys';

// Inside the audio message handler:
let placeholder = '[Voice message]';
try {
  const buffer = await downloadMediaMessage(msg, 'buffer', {});
  const transcript = await transcribeAudioBuffer(buffer as Buffer);
  if (transcript) placeholder = `[Voice: ${transcript}]`;
} catch (err) {
  // falls back to placeholder
}
```

### Build

```bash
npm run build
```

Fix any type errors before proceeding.

## Phase 4: Configure Service PATH

The service process needs `whisper-cli` and `ffmpeg` in its PATH. The simplest approach is to set `WHISPER_BIN` to the absolute path in `.env`:

```bash
echo "WHISPER_BIN=$(which whisper-cli)" >> .env
```

Alternatively, configure per platform:

**macOS (launchd):** Add `/opt/homebrew/bin` (Apple Silicon) or `/usr/local/bin` (Intel) to the PATH in the plist, then reload:

```bash
grep -A1 'PATH' ~/Library/LaunchAgents/com.nanoclaw.plist
# Edit the plist, then:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

**Linux (systemd):** Add `~/.local/bin` to the unit PATH via override:

```bash
systemctl --user cat nanoclaw | grep PATH
systemctl --user edit nanoclaw --force
# Add under [Service]:
# Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/<user>/.local/bin
```

## Phase 5: Restart and Verify

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Send a voice message in any registered group. The agent should receive it as `[Voice: <transcript>]`.

Check logs:

```bash
tail -f logs/nanoclaw.log | grep -iE "voice|transcri|whisper"
```

## Configuration

Environment variables (optional, set in `.env` or systemd/launchd override):

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_BIN` | `whisper-cli` | Full path to whisper-cli binary |
| `WHISPER_MODEL` | `data/models/ggml-base.bin` | Path to GGML model file |

## Troubleshooting

**`whisper.cpp transcription failed`**: Both `whisper-cli` and `ffmpeg` must be in the service PATH. The most reliable fix is setting the absolute path in `.env`:

```bash
echo "WHISPER_BIN=$(which whisper-cli)" >> .env
```

Test the pipeline manually:

```bash
ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -f wav /tmp/test.wav -y
whisper-cli -m data/models/ggml-base.bin -f /tmp/test.wav --no-timestamps -nt
```

**Works in dev but not as service**: PATH mismatch. Set `WHISPER_BIN` to the absolute path (see above).

**Wrong language detected**: whisper.cpp auto-detects language. To force a specific language, modify `src/transcription.ts` to pass `-l <lang_code>` to the `whisper-cli` call (e.g., `-l es` for Spanish).

**Slow on CPU**: The base model processes ~30s audio in <1s on Apple Silicon. On CPU-only Linux servers expect 5–15s per message. Use `ggml-base.bin` for best speed/accuracy balance.
