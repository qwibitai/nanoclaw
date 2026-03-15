---
name: add-voice-transcription-local
description: Add local voice message transcription to NanoClaw using whisper.cpp. No API keys needed. Automatically transcribes WhatsApp voice notes so the agent can read and respond to them.
---

# Add Local Voice Transcription (whisper.cpp)

This skill adds automatic voice message transcription using **whisper.cpp** — a fast, local, free alternative to the OpenAI Whisper API. When a voice note arrives, it is downloaded, transcribed locally, and delivered to the agent as `[Voice: <transcript>]`.

**No API keys. No costs. Runs entirely on your machine.**

## Prerequisites

- Linux or macOS host
- At least 400 MB free RAM (for the `tiny` model, default)
- 2+ CPU cores recommended
- ~80 MB disk space for the tiny model (~500 MB for small)

## Phase 1: Pre-flight

### Check if voice transcription is already applied

Read `.nanoclaw/state.yaml` if it exists. If `voice-transcription` or `voice-transcription-local` is in `applied_skills`, inform the user and ask if they want to replace the existing implementation.

### Check if whisper.cpp is already installed

```bash
which whisper-cpp 2>/dev/null || which main 2>/dev/null || ls /usr/local/bin/whisper-cpp 2>/dev/null
```

If found, skip to Phase 2 step 2.

## Phase 2: Install whisper.cpp on the Host

**IMPORTANT**: These steps run on the **host machine**, not inside a container.

### Step 1: Build whisper.cpp

```bash
cd /tmp
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
cmake -B build
cmake --build build --config Release -j$(nproc)
sudo cp build/bin/whisper-cli /usr/local/bin/whisper-cpp
```

Verify it works:
```bash
whisper-cpp --help
```

### Step 2: Download a model

Ask the user which model they want. Recommend based on their hardware:

| Model | RAM | Speed (2 cores) | Accuracy | Best for |
|-------|-----|-----------------|----------|----------|
| **tiny** | **~400 MB** | **~2-3s for 30s audio** | **Okay** | **Default — fast, good for clear speech** |
| base | ~500 MB | ~4s for 30s audio | Good | Budget hardware |
| small | ~1 GB | ~8s for 30s audio | Great | Best accuracy/speed balance |
| medium | ~2.5 GB | ~20s for 30s audio | Excellent | If you have 4+ GB RAM |

Download the default (tiny) model:

```bash
cd /tmp/whisper.cpp
bash models/download-ggml-model.sh tiny
sudo mkdir -p /usr/local/share/whisper
sudo cp models/ggml-tiny.bin /usr/local/share/whisper/
```

If the user wants a different model, replace `tiny` with their choice and update the filename accordingly.

### Step 3: Test transcription

Create a quick test (optional but recommended):

```bash
# Generate a test WAV file using ffmpeg (if available)
ffmpeg -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -ac 1 /tmp/test-whisper.wav 2>/dev/null
whisper-cpp -m /usr/local/share/whisper/ggml-tiny.bin -f /tmp/test-whisper.wav --no-timestamps -otxt 2>/dev/null
echo "whisper.cpp is working!"
```

## Phase 3: Apply Code Changes

### Create `src/transcription.ts`

Replace the existing `src/transcription.ts` (or create it new) with this implementation.

The key differences from the OpenAI API version:
- Uses `child_process.execFile` to call `whisper-cpp` binary
- Converts OGG audio to WAV using `ffmpeg` (WhatsApp sends OGG Opus)
- Reads env var `WHISPER_MODEL_PATH` for model location (defaults to `/usr/local/share/whisper/ggml-tiny.bin`)
- Reads env var `WHISPER_CPP_PATH` for binary location (defaults to `whisper-cpp` in PATH)
- No API key needed

Write this exact file to `src/transcription.ts`:

```typescript
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

interface TranscriptionConfig {
  whisperBin: string;
  modelPath: string;
  enabled: boolean;
  fallbackMessage: string;
  language: string;
}

function getConfig(): TranscriptionConfig {
  const env = readEnvFile(['WHISPER_CPP_PATH', 'WHISPER_MODEL_PATH', 'WHISPER_LANGUAGE']);
  return {
    whisperBin: env.WHISPER_CPP_PATH || 'whisper-cpp',
    modelPath: env.WHISPER_MODEL_PATH || '/usr/local/share/whisper/ggml-tiny.bin',
    enabled: true,
    fallbackMessage: '[Voice Message - transcription unavailable]',
    language: env.WHISPER_LANGUAGE || 'en',
  };
}

/**
 * Convert OGG/Opus audio (WhatsApp format) to 16kHz mono WAV (whisper.cpp format)
 * using ffmpeg.
 */
async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-ar', '16000',
    '-ac', '1',
    '-f', 'wav',
    '-y',
    outputPath,
  ], { timeout: 30000 });
}

/**
 * Transcribe a WAV file using whisper.cpp.
 * Returns the transcribed text or null on failure.
 */
async function transcribeWithWhisperCpp(
  wavPath: string,
  config: TranscriptionConfig,
): Promise<string | null> {
  // Verify model exists
  if (!fs.existsSync(config.modelPath)) {
    logger.error({ modelPath: config.modelPath }, 'Whisper model file not found');
    return null;
  }

  try {
    const { stdout, stderr } = await execFileAsync(config.whisperBin, [
      '-m', config.modelPath,
      '-f', wavPath,
      '--no-timestamps',
      '-l', config.language,
      '--output-txt',
      '-of', wavPath.replace('.wav', ''),
    ], { timeout: 120000 }); // 2 minute timeout for long voice notes

    // whisper.cpp writes output to <input>.txt
    const txtPath = wavPath.replace('.wav', '.txt');
    if (fs.existsSync(txtPath)) {
      const text = fs.readFileSync(txtPath, 'utf-8').trim();
      // Clean up the txt file
      fs.unlinkSync(txtPath);
      return text || null;
    }

    // Fallback: try to parse stdout (some versions output to stdout)
    if (stdout) {
      const lines = stdout.split('\n').filter((l: string) => l.trim() && !l.startsWith('['));
      const text = lines.join(' ').trim();
      if (text) return text;
    }

    logger.warn({ stderr: stderr?.slice(0, 200) }, 'whisper.cpp produced no output');
    return null;
  } catch (err) {
    logger.error({ err }, 'whisper.cpp transcription failed');
    return null;
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = getConfig();

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  const tmpDir = os.tmpdir();
  const timestamp = Date.now();
  const oggPath = path.join(tmpDir, `nanoclaw-voice-${timestamp}.ogg`);
  const wavPath = path.join(tmpDir, `nanoclaw-voice-${timestamp}.wav`);

  try {
    // Download the audio from WhatsApp
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: console as any,
        reuploadRequest: sock.updateMediaMessage,
      },
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger.error('Failed to download audio message');
      return config.fallbackMessage;
    }

    logger.info({ bytes: buffer.length }, 'Downloaded audio message');

    // Write OGG to temp file
    fs.writeFileSync(oggPath, buffer);

    // Convert OGG → WAV
    await convertToWav(oggPath, wavPath);
    logger.debug({ wavPath }, 'Converted audio to WAV');

    // Transcribe with whisper.cpp
    const transcript = await transcribeWithWhisperCpp(wavPath, config);

    if (!transcript) {
      return config.fallbackMessage;
    }

    logger.info({ length: transcript.length }, 'Transcribed voice message');
    return transcript.trim();
  } catch (err) {
    logger.error({ err }, 'Transcription error');
    return config.fallbackMessage;
  } finally {
    // Clean up temp files
    try { fs.unlinkSync(oggPath); } catch {}
    try { fs.unlinkSync(wavPath); } catch {}
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
```

### Update `src/channels/whatsapp.ts`

If the voice-transcription skill (API version) has NOT already been applied, make the same modifications to whatsapp.ts as described in the original `/add-voice-transcription` skill's intent file:

1. Add import: `import { isVoiceMessage, transcribeAudioMessage } from '../transcription.js';`
2. In the `messages.upsert` handler, add voice message detection and transcription (see the modify/src/channels/whatsapp.ts.intent.md from the original skill)

If the API version WAS already applied, the whatsapp.ts changes are already in place — only `src/transcription.ts` needs to be replaced.

### Ensure ffmpeg is available

ffmpeg is needed to convert WhatsApp's OGG Opus audio to WAV format.

Check if it's installed on the host:
```bash
which ffmpeg
```

If not:
```bash
# Ubuntu/Debian
sudo apt-get install -y ffmpeg

# macOS
brew install ffmpeg
```

Also ensure ffmpeg is available inside the container. Read the Dockerfile or container build script and add ffmpeg if needed:

```dockerfile
RUN apk add --no-cache ffmpeg
```

Or for Debian-based containers:
```dockerfile
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
```

### Important: Host vs Container

whisper.cpp runs on the **host**, not inside the container. The transcription happens in NanoClaw's main process (which runs on the host) before the message is passed to the container agent.

However, ffmpeg DOES need to be on the host since transcription runs there.

## Phase 4: Configure

### Add to environment

Add these to `.env` (with defaults that work out of the box):

```bash
# Voice transcription (whisper.cpp)
WHISPER_CPP_PATH=whisper-cpp
WHISPER_MODEL_PATH=/usr/local/share/whisper/ggml-tiny.bin
WHISPER_LANGUAGE=auto
```

Notes on `WHISPER_LANGUAGE`:
- `auto` — auto-detects language per voice note (recommended for multilingual users, adds ~1s)
- `en` — English only (fastest)
- `sv` — Swedish only
- Any ISO 639-1 code supported by Whisper

To upgrade to a better model later, just change the path:
```bash
WHISPER_MODEL_PATH=/usr/local/share/whisper/ggml-small.bin
```

Sync to container environment:
```bash
mkdir -p data/env && cp .env data/env/env
```

### Remove OpenAI dependency (if replacing API version)

If the OpenAI API version was previously installed:
```bash
npm uninstall openai
```

Remove `OPENAI_API_KEY` from `.env` if it was only used for transcription.

### Build and restart

```bash
npm run build
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
# systemctl --user restart nanoclaw
# Or:
# bash start-nanoclaw.sh
```

## Phase 5: Verify

### Test with a voice note

Tell the user:

> Send a voice note in any registered WhatsApp chat. The agent should receive it as `[Voice: <transcript>]` and respond to its content.
>
> First transcription may take a few extra seconds as the model loads into memory. Subsequent ones will be faster.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i voice
```

Look for:
- `Downloaded audio message` — audio received from WhatsApp
- `Converted audio to WAV` — ffmpeg conversion succeeded
- `Transcribed voice message` — whisper.cpp succeeded
- `Whisper model file not found` — model not at expected path
- `whisper.cpp transcription failed` — binary error (check installation)

### Performance expectations

*tiny model (default):*

| Audio length | 2 cores | 4 cores |
|-------------|---------|---------|
| 10 seconds | ~1s | <1s |
| 30 seconds | ~2-3s | ~1-2s |
| 60 seconds | ~5s | ~3s |
| 5 minutes | ~20s | ~12s |

*small model (upgrade):*

| Audio length | 2 cores | 4 cores |
|-------------|---------|---------|
| 10 seconds | ~3s | ~2s |
| 30 seconds | ~8s | ~4s |
| 60 seconds | ~15s | ~8s |
| 5 minutes | ~60s | ~35s |

## Troubleshooting

### "whisper-cpp: command not found"

The binary isn't in PATH. Either:
1. Set `WHISPER_CPP_PATH=/usr/local/bin/whisper-cpp` in `.env`
2. Or create a symlink: `sudo ln -s /tmp/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cpp`

### "Whisper model file not found"

The model isn't where expected. Set `WHISPER_MODEL_PATH` in `.env` to the actual path:
```bash
find / -name "ggml-tiny.bin" 2>/dev/null
```

### "ffmpeg: command not found"

Install ffmpeg:
```bash
# Ubuntu/Debian
sudo apt-get install -y ffmpeg
# macOS
brew install ffmpeg
```

### Transcription is too slow

- Try the `base` or `tiny` model instead (faster but less accurate)
- Check CPU usage during transcription — if maxed out, the model may be too large for your hardware

### Transcription accuracy is poor

- Try a larger model (`medium` if you have 2.5+ GB RAM)
- Set the correct language: `WHISPER_LANGUAGE=sv` for Swedish, `en` for English
- Use `auto` for mixed-language voice notes (slightly slower)

## Removal

To remove local voice transcription:

1. Delete `src/transcription.ts` (or revert to a stub that returns the fallback message)
2. Remove the `isVoiceMessage` check and transcription block from `src/channels/whatsapp.ts`
3. Remove `WHISPER_CPP_PATH`, `WHISPER_MODEL_PATH`, `WHISPER_LANGUAGE` from `.env`
4. Optionally remove whisper.cpp: `sudo rm /usr/local/bin/whisper-cpp && sudo rm -rf /usr/local/share/whisper`
5. Rebuild: `npm run build && bash start-nanoclaw.sh`
