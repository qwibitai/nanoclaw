# Jarvis Voice Assistant

A voice-activated AI assistant that listens for the wake word "Hey Jarvis" and processes voice commands through the NanoClaw API. Built for macOS with on-device speech recognition.

## Requirements

- **macOS**: 10.15 (Catalina) or later
- **Python**: 3.8 or higher
- **Microphone**: Built-in or external microphone
- **Permissions**:
  - Microphone access (System Settings > Privacy & Security > Microphone)
  - Speech Recognition (System Settings > Privacy & Security > Speech Recognition)
- **NanoClaw API**: Running at `http://localhost:3100`

## Installation

1. Install Python dependencies:

```bash
pip install -r requirements.txt
```

2. Download the Vosk model (fallback transcription):

```bash
mkdir -p vosk-models
cd vosk-models
curl -LO https://alphacephei.com/vosk/models/vosk-model-en-us-0.22.zip
unzip vosk-model-en-us-0.22.zip
rm vosk-model-en-us-0.22.zip
```

3. Grant permissions when prompted:
   - Allow microphone access for Terminal/Python
   - Allow speech recognition for Terminal/Python

## Configuration

Jarvis can be configured via command-line arguments:

| Argument | Description | Default |
|----------|-------------|---------|
| `--check` | Run validation checks and exit | - |
| `--device <N>` | Specify microphone device number | Auto-detect |
| `--no-notify` | Disable macOS notifications | Enabled |

### Configuration File

The `Config` class in `jarvis.py` contains additional settings:

| Setting | Description | Default |
|---------|-------------|---------|
| `nanoclaw_url` | NanoClaw API endpoint | `http://localhost:3100` |
| `sample_rate` | Audio sample rate (Hz) | `16000` |
| `recording_duration` | Seconds to record after wake word | `5` |
| `oww_threshold` | Wake word detection sensitivity | `0.15` |
| `state_timeout` | Max seconds in non-IDLE state | `60.0` |

## Usage

### Start the Assistant

```bash
python3 jarvis.py
```

### Run Validation Checks

Check if all components are ready before starting:

```bash
python3 jarvis.py --check
```

This validates:
- Microphone availability and functionality
- Vosk model presence and integrity
- NanoClaw API connectivity

### Specify Microphone Device

To list available devices:

```bash
python3 -c "import sounddevice as sd; print(sd.query_devices())"
```

Then use a specific device:

```bash
python3 jarvis.py --device 2
```

### Disable Notifications

Run without macOS notifications:

```bash
python3 jarvis.py --no-notify
```

## Architecture

### State Machine

Jarvis operates as a finite state machine:

```
IDLE ---------> PING ---------> RECORDING ---------> PROCESSING
   ^              |                  |                    |
   |              v                  v                    v
   |         (barge-in)         (barge-in)           SPEAKING
   |              |                  |                    |
   +--------------<------------------<--------------------+
```

**States:**
- **IDLE**: Waiting for wake word detection
- **PING**: Playing activation sound
- **RECORDING**: Capturing user voice command
- **PROCESSING**: Transcribing and sending to API
- **SPEAKING**: Playing TTS response (supports barge-in)

### Components

| Component | Technology | Purpose |
|-----------|------------|---------|
| Wake Word Detection | openWakeWord | Detects "Hey Jarvis" |
| Transcription (Primary) | Apple Speech Framework | On-device speech-to-text |
| Transcription (Fallback) | Vosk | Offline backup transcription |
| Text-to-Speech | macOS `say` command | Voice output |
| Backend | NanoClaw API | AI response generation |
| Audio Capture | sounddevice | Microphone input |

### Audio Flow

```
Microphone -> sounddevice -> queues -> wake word listener thread
                                -> main thread (recording/transcription)
```

## Troubleshooting

### Permission Issues

**Problem**: Microphone or speech recognition not working.

**Solution**:
1. Open System Settings > Privacy & Security
2. Grant microphone access to your terminal/Python
3. Grant speech recognition access to your terminal/Python
4. Restart Jarvis

### No Audio Detected

**Problem**: "Too quiet" message or no wake word activation.

**Solution**:
1. Check microphone is selected correctly with `--check`
2. Try a different device with `--device N`
3. Speak closer to the microphone
4. Check system microphone input volume

### API Not Running

**Problem**: "Cannot connect to localhost:3100"

**Solution**:
1. Ensure NanoClaw is running: `systemctl --user status nanoclaw`
2. Start NanoClaw: `systemctl --user start nanoclaw`
3. Check the API URL in configuration

### Wake Word Not Detecting

**Problem**: Jarvis doesn't respond to "Hey Jarvis".

**Solution**:
1. Speak clearly and at normal volume
2. Lower the threshold in `Config.oww_threshold` (currently 0.15)
3. Check for background noise interference
4. Verify microphone is capturing audio with `--check`

### Transcription Issues

**Problem**: Empty or incorrect transcriptions.

**Solution**:
1. Speak clearly after the ping sound
2. Wait for the "Listening..." notification
3. Check speech recognition permissions
4. Try speaking closer to the microphone

### Zombie Processes

**Problem**: Leftover `caffeinate` processes after crash.

**Solution**:
```bash
pkill -f caffeinate
```

Jarvis now handles cleanup automatically via signal handlers.

## Dependencies

| Package | Purpose |
|---------|---------|
| `openwakeword` | Wake word detection ("Hey Jarvis") |
| `pyobjc-framework-Speech` | macOS native speech recognition |
| `sounddevice` | Audio capture from microphone |
| `numpy` | Audio data processing |
| `vosk` | Fallback offline speech recognition |
| `requests` | HTTP client for NanoClaw API |
| `pyyaml` | Configuration file parsing |

## Logging

Jarvis logs to stdout with timestamps:

```
[14:30:15] Ready! Say 'HEY JARVIS' to activate.
[14:30:22] WAKE: 'hey_jarvis' detected (score: 0.85)
[14:30:22] State: IDLE -> PING
[14:30:23] State: PING -> RECORDING
[14:30:28] State: RECORDING -> PROCESSING
[14:30:29] You said: 'what time is it'
[14:30:30] State: PROCESSING -> SPEAKING
[14:30:32] Jarvis: It's 2:30 PM.
```

## Files

| File | Purpose |
|------|---------|
| `jarvis.py` | Main application entry point |
| `requirements.txt` | Python dependencies |
| `vosk-models/` | Vosk model directory |
| `/tmp/jarvis.lock` | Single instance lock file |
