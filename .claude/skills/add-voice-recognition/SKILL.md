---
name: add-voice-recognition
description: Add speaker recognition to NanoClaw using PyAnnote voice embeddings. Identifies the user's voice to distinguish direct commands from shared/forwarded audio.
---

# Add Voice Recognition

This skill adds speaker recognition to NanoClaw's WhatsApp voice transcription using PyAnnote audio embeddings. It allows the system to:
- Recognize the user's voice and tag messages as "Direct from [User]"
- Identify forwarded/shared audio with different speakers
- Distinguish commands (from user) vs information (from others)

## How It Works

1. **Voice Enrollment**: User records 3-5 voice samples
2. **Profile Generation**: System extracts voice embeddings and creates a profile
3. **Speaker Identification**: Each new voice note is compared against the stored profile
4. **Smart Tagging**: Messages are tagged with speaker information

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `voice-recognition` is in `applied_skills`, the code changes are already in place.

### Prerequisites

- Python 3.8+ must be installed
- Voice transcription skill must be active (either OpenAI or ElevenLabs)

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-voice-recognition
```

This deterministically:
- Adds `src/voice-recognition.ts` (speaker identification module using PyAnnote)
- Adds `scripts/voice-recognition-service.py` (Python microservice for embeddings)
- Installs Python dependencies (`pyannote.audio`, `torch`, `numpy`)
- Creates voice profile storage at `data/voice-profiles/`
- Integrates with existing transcription module
- Records the application in `.nanoclaw/state.yaml`

### Install Python dependencies

Create a virtual environment and install dependencies:

```bash
python3 -m venv scripts/venv
scripts/venv/bin/pip install pyannote.audio torch numpy
```

The service uses this venv by default (`scripts/venv/bin/python3`). Override with `VOICE_PYTHON_PATH` env var if using a different Python installation.

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Voice Enrollment

### Collect voice samples

The user needs to record 3-5 voice notes (10-30 seconds each) with varied content:

**Sample Scripts:**
1. "Hey Andy, this is [Name]. I'm recording this voice sample so you can learn to recognize my voice. The quick brown fox jumps over the lazy dog."
2. "Andy, can you remind me to call Sarah tomorrow at 3 PM? Also, I need to pick up groceries on the way home. Thanks!"
3. "Good morning Andy! I just wanted to let you know that I'll be working from home today."
4. "Andy, what's the weather like today? Do I have any appointments scheduled?"
5. "Set a timer for 10 minutes. Add milk and bread to my shopping list."

### Process enrollment

After receiving the voice samples, run:

```bash
npx tsx scripts/enroll-voice.ts --user="[User Name]" --count=5
```

This will:
- Extract the last 5 voice messages from the user
- Generate embeddings for each
- Create an averaged voice profile
- Save to `data/voice-profiles/[user].json`

### Verify enrollment

Send a test voice note. The system should respond with `[Direct from [User]]`.

To save audio for enrollment, set `VOICE_SAVE_AUDIO=true` in your `.env` file before sending voice messages.

## Phase 4: Usage

### How it tags messages

After enrollment, voice notes are automatically tagged:

- `[Direct from Yonatan]` - User's voice detected (similarity > 75%)
- `[Shared audio: Unknown speaker]` - Different voice detected
- `[Multiple speakers: Yonatan + 1 other]` - Conversation with multiple people

### Confidence scores

The metadata includes similarity scores:
- `[Direct from Yonatan, 92% match]` - High confidence
- `[Possibly Yonatan, 68% match]` - Medium confidence
- `[Different speaker, 23% match]` - Low confidence

## Phase 5: Maintenance

### Update voice profile

The system automatically updates your profile during regular use (continuous learning). For manual re-enrollment with new samples:

```bash
npx tsx scripts/enroll-voice.ts --user="[User Name]" --count=3
```

This replaces the existing profile with a fresh average of the 3 most recent audio files.

### Reset voice profile

To start over:

```bash
rm data/voice-profiles/[user].json
```

Then re-enroll with new samples.

## Troubleshooting

### Python service not starting

Check Python dependencies:
```bash
python3 -c "import pyannote.audio; print('PyAnnote OK')"
```

### Low recognition accuracy

- Record more enrollment samples (5-7 recommended)
- Ensure enrollment samples have varied content
- Check audio quality (avoid background noise)
- Update threshold in `src/voice-recognition.ts` (default 0.75)

### Voice profile not found

Ensure enrollment completed successfully:
```bash
ls -la data/voice-profiles/
```

Should show `[user].json` file with embedding data.
