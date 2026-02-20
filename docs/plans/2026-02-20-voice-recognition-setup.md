# Voice Recognition Setup Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete Andy's voice recognition skill — install deps, fix issues, create voice profile, integrate, deploy.

**Prerequisite:** Server must be upgraded to 8GB RAM (user is doing this now). Verify with `free -h` before starting.

**Current droplet:** `s-2vcpu-4gb-120gb-intel` in NYC1. Upgrading to 8GB.

---

## Context: What Already Exists

Andy (the agent inside the container) built the voice recognition system. Files are already on disk but have issues that need fixing.

### Files already created (uncommitted):
- `src/voice-recognition.ts` — TypeScript module, calls Python for embeddings
- `scripts/voice-recognition-service.py` — Python CLI service using PyAnnote
- `scripts/enroll-voice.ts` — Enrollment script (BROKEN — see issues)
- `scripts/setup-voice-recognition.sh` — Dependency installer
- `data/voice-profiles/enrollment-samples.txt` — Documents 5 samples Yonatan sent
- `VOICE_RECOGNITION_SETUP.md` — Andy's setup guide (reference only)

### Skill directory:
- `.claude/skills/add-voice-recognition/manifest.yaml` — BROKEN schema
- `.claude/skills/add-voice-recognition/SKILL.md` — Good reference
- `.claude/skills/add-voice-recognition/add/src/voice-recognition.ts`
- `.claude/skills/add-voice-recognition/add/scripts/enroll-voice.ts`
- `.claude/skills/add-voice-recognition/add/scripts/voice-recognition-service.py`

### What's already integrated (from other skills):
- Voice transcription works (ElevenLabs Scribe v2)
- `src/channels/whatsapp.ts` already downloads audio and transcribes voice notes
- Shabbat mode is fully deployed and working

---

## Issues to Fix

### 1. Enrollment script can't work as-is
`enroll-voice.ts` calls `initBaileys()` to create a new WhatsApp connection. WhatsApp only allows ONE connection per phone number — NanoClaw already holds it. The enrollment script would disconnect the running instance.

**Fix:** Rewrite enrollment to work with saved audio files instead. Modify the transcription pipeline to save raw audio to disk when enrollment mode is active, OR pull voice message media from the WhatsApp message store using existing Baileys socket.

### 2. Manifest doesn't match skills engine schema
Missing: `core_version`, `modifies`, `conflicts`, `depends`, `test`. Uses non-standard fields.

**Fix:** Rewrite manifest following the add-shabbat-mode pattern.

### 3. PyAnnote requires HuggingFace auth token
The `pyannote/embedding` model requires:
1. A HuggingFace account
2. Accepting model terms at https://huggingface.co/pyannote/embedding
3. An access token passed to the model

**Fix:** Add HF token handling to the Python service (env var `HF_TOKEN`).

### 4. Python service spawns per-call (very slow)
Each `identifySpeaker()` call spawns `python3 voice-recognition-service.py`, which loads the full PyAnnote model (~10-30s). Unusable in production.

**Fix:** Either:
- (a) Make Python service a long-running daemon with stdin/stdout JSON-RPC, OR
- (b) Extract embedding once during transcription and do cosine similarity in TypeScript (just a dot product — no Python needed for comparison). Only use Python for `extract` command.

Option (b) is simpler and recommended. The `compareEmbeddings` and `createProfile` functions are just numpy operations that TypeScript can do natively.

### 5. CLI argument length limits
`compareEmbeddings()` passes 512-dim float arrays as CLI arguments. This can exceed shell arg limits.

**Fix:** Use stdin for passing data to Python, or implement comparison in TypeScript (see #4).

### 6. Voice samples need re-sending
The 5 enrollment samples Yonatan sent earlier were transcribed but raw audio wasn't saved. Audio must be re-sent after the system is ready to capture it.

### 7. Integration with whatsapp.ts not done
Need to add `identifySpeaker()` call after transcription in the voice message handling path.

---

## Implementation Plan

### Task 1: Verify server upgrade
- Run `free -h` to confirm 8GB RAM
- Confirm NanoClaw service is running after reboot

### Task 2: Install Python dependencies
```bash
pip3 install --user pyannote.audio torch torchaudio numpy
```
- Ask user for HuggingFace token (needs to accept pyannote/embedding model terms)
- Add `HF_TOKEN` to `.env`

### Task 3: Rewrite Python service as stdin/stdout daemon
Instead of spawning per-call, make `voice-recognition-service.py` a long-running process:
- Reads JSON commands from stdin
- Writes JSON responses to stdout
- Loads PyAnnote model once at startup
- Commands: `extract` (audio path → embedding), `health` (check model loaded)

Move `compare` and `create_profile` to TypeScript (pure math, no Python needed).

### Task 4: Rewrite voice-recognition.ts
- Implement `cosineSimilarity()` and `averageEmbeddings()` in TypeScript
- Spawn Python daemon on first use, reuse connection
- Only call Python for `extract` (embedding from audio file)
- Keep profile management (load/save/list) as-is

### Task 5: Fix manifest and skill structure
Rewrite `manifest.yaml` to match skills engine schema:
```yaml
skill: voice-recognition
version: 1.0.0
description: "Speaker recognition using PyAnnote voice embeddings"
core_version: 0.1.0
adds:
  - src/voice-recognition.ts
  - scripts/voice-recognition-service.py
modifies:
  - src/channels/whatsapp.ts
conflicts: []
depends:
  - voice-transcription  # or voice-transcription-elevenlabs
test: "npx vitest run src/voice-recognition.test.ts"
```

Create `modify/src/channels/whatsapp.ts` with speaker identification integration.

### Task 6: Write enrollment approach
Instead of a separate WhatsApp connection, add an enrollment mode to the main process:
- When NanoClaw receives a command like "enroll my voice", save the next N voice messages' raw audio to `data/voice-profiles/enrollment/`
- Then run a separate script to process saved audio files into a profile
- OR: simpler — write a script that takes audio file paths as arguments

### Task 7: Create voice profile for Yonatan
- User re-sends 5 voice samples
- System saves raw audio during enrollment mode
- Process audio → embeddings → averaged profile
- Save to `data/voice-profiles/Yonatan.json`

### Task 8: Integration test
- Send a voice note from Yonatan → should tag as `[Direct from Yonatan, XX% match]`
- Forward someone else's voice note → should tag as `[Unknown speaker]`

### Task 9: Build and deploy
- `npm run build`
- `systemctl --user restart nanoclaw`
- Verify in logs

---

## Notes

- See `memory/skills-engine.md` for skills engine gotchas (staging issue, structured ops limitations)
- The `.nanoclaw/` directory already exists (initialized during shabbat-mode setup)
- Node.js PATH for non-interactive shells: `export PATH="/home/yaz/.nvm/versions/node/v22.22.0/bin:$PATH"`
- Origin remote is `jonazri/nanoclaw`, upstream is `qwibitai/nanoclaw`
