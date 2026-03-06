# NanoClaw Voice Daemon

Hands-free voice assistant for [NanoClaw](https://github.com/gavrielc/nanoclaw) on macOS. Talk to your Claude-powered assistant using wake word detection, automatic speech-to-text, and voice responses — no keyboard needed.

## How It Works

1. Daemon listens for the wake word **"Hey Gimme"** (phonetic for "Gimi" — **G**host **I**n **M**achine)
2. **Purr** sound plays (recording started)
3. Speak your message
4. Say **"Hey Gimme"** again — **Pop** sound plays (recording stopped)
5. Audio is transcribed via OpenAI Whisper API
6. Transcription is injected into NanoClaw's SQLite DB as a `[Voice: ...]` message
7. NanoClaw processes it, responds with voice (OpenAI TTS) via Telegram + plays locally on Mac via `ffplay` at 1.25x speed
8. Say **"Hey Gimme"** during playback to **interrupt** it (stops audio without starting a new recording)

## Architecture

```
Microphone
    |
    v
Porcupine (wake word detection, always listening)
    |
    v  "Hey Gimme" detected
Start recording ---> "Hey Gimme" again ---> Stop recording
    |                                            |
    v                                            v
                                        OpenAI Whisper API (STT)
                                                 |
                                                 v
                                     SQLite DB injection
                                                 |
                                                 v
                                        NanoClaw message loop
                                                 |
                                                 v
                                      Claude Agent (container)
                                                 |
                                                 v
                                   OpenAI TTS API --> Telegram voice message
                                                 |
                                                 v
                                        ffplay (local Mac playback, 1.25x)
                                                 |
                                                 v
                                   PID file (/tmp/nanoclaw-playback.pid)
                                   "Hey Gimme" during playback = interrupt
```

The voice daemon is a standalone Python process, independent of the NanoClaw Node.js process. It communicates only through SQLite — inserts a message and NanoClaw picks it up in the next poll cycle.

## Prerequisites

| Requirement | Purpose | Cost |
|-------------|---------|------|
| **macOS** with Apple Silicon or Intel | Porcupine + launchd + system sounds | - |
| **Python 3.10+** | Voice daemon runtime | Free |
| **Picovoice account** | Wake word detection (Porcupine) | Free tier: 3 custom wake words/month, personal use |
| **OpenAI API key** | Whisper (STT) + TTS | ~$0.006/min STT, ~$0.015/1K chars TTS |
| **ffmpeg** (includes ffplay) | Local audio playback | Free (`brew install ffmpeg`) |
| **Telegram bot** | Voice response delivery | Free (via @BotFather) |

### Why Telegram?

WhatsApp voice transcription (inbound) works fine, but voice *responses* (outbound) cause an echo loop in self-chat mode — the bot's voice message gets re-transcribed as a new input. Telegram doesn't have this issue because bot messages are clearly separated.

### Outdoor / Backpack Use

For hands-free use with the MacBook lid closed (e.g. in a backpack):

| Item | Why | Notes |
|------|-----|-------|
| **USB wireless headset with dongle** | Audio input/output with lid closed | Built-in mic does NOT work with lid closed! |
| **USB-C hub** | Connect USB headset dongle | If headset isn't USB-C native |
| **Amphetamine app** (Mac App Store, free) | Prevents sleep with lid closed | Set Trigger → uncheck "Allow system to sleep when display is closed" |
| **USB-C power bank** (recommended) | Extends battery + ensures clamshell mode | macOS is more reliable with power connected |

**Critical**: Set the USB headset as default audio input before closing the lid:
```bash
brew install switchaudio-osx
SwitchAudioSource -t input -s "Your Headset Name"
# Then restart voice daemon
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.voice-daemon
```

Why not AirPods? They work, but macOS sometimes switches back to built-in mic after sleep/wake cycles. A USB dongle headset stays as default input reliably.

## Setup

### 1. Get your API keys

**Picovoice (wake word):**
1. Sign up at https://console.picovoice.ai (free)
2. Copy your **AccessKey** from the dashboard

**OpenAI (transcription + TTS):**
1. Sign up at https://platform.openai.com
2. Create an API key with access to `whisper-1` and `tts-1` models

### 2. Train your wake word

1. Go to https://console.picovoice.ai/ppn
2. Click **Create Custom Wake Word**
3. Enter **"Hey Gimme"** as the phrase
   - This sounds like "Hey Gimi" when spoken naturally
   - You can choose any phrase — just update `KEYWORD_PATH` in `voice-daemon.py`
4. Select your platform: **macOS (arm64)** for Apple Silicon or **macOS (x86_64)** for Intel
5. Download the `.ppn` file to the `porcupine/` directory

> **Note:** Free tier allows 1 custom wake word training per month. "Hey Gimme" is used as both start and stop trigger. After a month, you could train a separate stop word (e.g., "Konec") for a more natural flow.

### 3. Configure environment

Add to your NanoClaw `.env` file:

```bash
PICOVOICE_ACCESS_KEY=your-access-key-here
OPENAI_API_KEY=sk-your-key-here
TELEGRAM_BOT_TOKEN=your-bot-token-here
```

### 4. Install Python dependencies

```bash
cd porcupine
python3 -m venv venv
source venv/bin/activate
pip install pvporcupine pvrecorder openai
```

### 5. Configure the daemon

Edit `voice-daemon.py`:
- `CHAT_JID` — your Telegram chat JID (get it by sending `/chatid` to your bot)
- `KEYWORD_PATH` — path to your `.ppn` file

### 6. Test manually

```bash
PYTHONUNBUFFERED=1 porcupine/venv/bin/python3 porcupine/voice-daemon.py
```

Say "Hey Gimme", speak, say "Hey Gimme" again. You should see transcription output and get a response in Telegram.

### 7. Install as launchd service

```bash
# Copy and edit the plist (update paths if your nanoclaw is not at ~/nanoclaw)
cp porcupine/com.nanoclaw.voice-daemon.plist ~/Library/LaunchAgents/

# Load the service
launchctl load ~/Library/LaunchAgents/com.nanoclaw.voice-daemon.plist

# Check it's running
launchctl list | grep voice-daemon
```

Service management:
```bash
# Restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.voice-daemon

# Stop
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.voice-daemon.plist

# Logs
tail -f logs/voice-daemon.log
```

## Configuration

| Setting | File | Default |
|---------|------|---------|
| Wake word | `voice-daemon.py` → `KEYWORD_PATH` | `Hey-Gimme_en_mac_v4_0_0.ppn` |
| Sensitivity | `voice-daemon.py` → `sensitivities` | `0.6` |
| Start sound | `voice-daemon.py` → `SOUND_START` | `/System/Library/Sounds/Purr.aiff` |
| Stop sound | `voice-daemon.py` → `SOUND_STOP` | `/System/Library/Sounds/Pop.aiff` |
| Target chat | `voice-daemon.py` → `CHAT_JID` | `tg:8253215818` |
| Playback speed | `src/index.ts` → `atempo` | `1.25` |
| TTS voice | `src/tts.ts` → `voice` | `nova` |

## Files

| File | Description |
|------|-------------|
| `voice-daemon.py` | Main daemon script |
| `Hey-Gimme_en_mac_v4_0_0.ppn` | Trained wake word model (not in git — train your own) |
| `com.nanoclaw.voice-daemon.plist` | launchd service config |
| `LICENSE.txt` | Porcupine license attribution |
| `venv/` | Python virtual environment (in .gitignore) |

## Support This Project

If you find this useful, consider a small donation:

**Lightning Bitcoin (instant, near-zero fees):**

`snazzymachine723@walletofsatoshi.com`

Or scan the QR code in your Lightning wallet.

Built with NanoClaw, Claude, Porcupine, and OpenAI. Runs entirely on your Mac.
