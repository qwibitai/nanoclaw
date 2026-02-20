# ElevenLabs Voice Transcription Skill Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create the `add-voice-transcription-elevenlabs` skill package that provides voice note transcription via ElevenLabs Scribe v2, as an alternative to the existing OpenAI Whisper skill.

**Architecture:** New skill in `.claude/skills/add-voice-transcription-elevenlabs/` mirroring the existing OpenAI skill structure. Replaces `src/transcription.ts` with an ElevenLabs implementation. The `modify/` files (whatsapp.ts, whatsapp.test.ts) are identical copies since the transcription module has the same public API surface. Manifest declares a conflict with the OpenAI skill.

**Tech Stack:** ElevenLabs Scribe v2 batch API via `@elevenlabs/elevenlabs-js` SDK

---

### Task 1: Create manifest.yaml

**Files:**
- Create: `.claude/skills/add-voice-transcription-elevenlabs/manifest.yaml`

**Step 1: Write the manifest**

```yaml
skill: voice-transcription-elevenlabs
version: 1.0.0
description: "Voice message transcription via ElevenLabs Scribe v2"
core_version: 0.1.0
adds:
  - src/transcription.ts
modifies:
  - src/channels/whatsapp.ts
  - src/channels/whatsapp.test.ts
structured:
  npm_dependencies:
    "@elevenlabs/elevenlabs-js": "^2.36.0"
  env_additions:
    - ELEVENLABS_API_KEY
conflicts:
  - voice-transcription
depends: []
test: "npx vitest run src/channels/whatsapp.test.ts"
```

**Step 2: Commit**

```bash
git add .claude/skills/add-voice-transcription-elevenlabs/manifest.yaml
git commit -m "feat(skill): add manifest for elevenlabs voice transcription"
```

---

### Task 2: Create transcription.ts (ElevenLabs implementation)

**Files:**
- Create: `.claude/skills/add-voice-transcription-elevenlabs/add/src/transcription.ts`
- Reference: `.claude/skills/add-voice-transcription/add/src/transcription.ts` (OpenAI version to mirror)

The public API must be identical to the OpenAI version: exports `isVoiceMessage(msg)` and `transcribeAudioMessage(msg, sock)`.

**Step 1: Write the transcription module**

```typescript
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { WAMessage, WASocket } from '@whiskeysockets/baileys';

import { readEnvFile } from './env.js';

interface TranscriptionConfig {
  model: string;
  enabled: boolean;
  fallbackMessage: string;
}

const DEFAULT_CONFIG: TranscriptionConfig = {
  model: 'scribe_v2',
  enabled: true,
  fallbackMessage: '[Voice Message - transcription unavailable]',
};

async function transcribeWithElevenLabs(
  audioBuffer: Buffer,
  config: TranscriptionConfig,
): Promise<string | null> {
  const env = readEnvFile(['ELEVENLABS_API_KEY']);
  const apiKey = env.ELEVENLABS_API_KEY;

  if (!apiKey) {
    console.warn('ELEVENLABS_API_KEY not set in .env');
    return null;
  }

  try {
    const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
    const client = new ElevenLabsClient({ apiKey });

    const audioBlob = new Blob([audioBuffer], { type: 'audio/ogg' });

    const result = await client.speechToText.convert({
      file: audioBlob,
      modelId: config.model,
      tagAudioEvents: false,
      diarize: false,
    });

    return result.text;
  } catch (err) {
    console.error('ElevenLabs transcription failed:', err);
    return null;
  }
}

export async function transcribeAudioMessage(
  msg: WAMessage,
  sock: WASocket,
): Promise<string | null> {
  const config = DEFAULT_CONFIG;

  if (!config.enabled) {
    return config.fallbackMessage;
  }

  try {
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
      console.error('Failed to download audio message');
      return config.fallbackMessage;
    }

    console.log(`Downloaded audio message: ${buffer.length} bytes`);

    const transcript = await transcribeWithElevenLabs(buffer, config);

    if (!transcript) {
      return config.fallbackMessage;
    }

    return transcript.trim();
  } catch (err) {
    console.error('Transcription error:', err);
    return config.fallbackMessage;
  }
}

export function isVoiceMessage(msg: WAMessage): boolean {
  return msg.message?.audioMessage?.ptt === true;
}
```

**Step 2: Commit**

```bash
git add .claude/skills/add-voice-transcription-elevenlabs/add/src/transcription.ts
git commit -m "feat(skill): add ElevenLabs transcription module"
```

---

### Task 3: Copy modify/ directory from OpenAI skill

The `modify/` files are identical because both skills produce the same `transcription.ts` public API (`isVoiceMessage`, `transcribeAudioMessage`). The whatsapp.ts integration code imports from `../transcription.js` regardless of provider.

**Files:**
- Create: `.claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.ts` (copy from OpenAI skill)
- Create: `.claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.ts.intent.md` (copy from OpenAI skill)
- Create: `.claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.test.ts` (copy from OpenAI skill)
- Create: `.claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.test.ts.intent.md` (copy from OpenAI skill)

**Step 1: Copy all modify/ files**

```bash
mkdir -p .claude/skills/add-voice-transcription-elevenlabs/modify/src/channels
cp .claude/skills/add-voice-transcription/modify/src/channels/whatsapp.ts \
   .claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.ts
cp .claude/skills/add-voice-transcription/modify/src/channels/whatsapp.ts.intent.md \
   .claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.ts.intent.md
cp .claude/skills/add-voice-transcription/modify/src/channels/whatsapp.test.ts \
   .claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.test.ts
cp .claude/skills/add-voice-transcription/modify/src/channels/whatsapp.test.ts.intent.md \
   .claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.test.ts.intent.md
```

**Step 2: Update the intent file for whatsapp.ts to reference ElevenLabs**

In `.claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.ts.intent.md`, change the first sentence from "Added voice message transcription support. When a WhatsApp voice note (PTT audio) arrives, it is downloaded and transcribed via OpenAI Whisper before being stored as message content." to "Added voice message transcription support. When a WhatsApp voice note (PTT audio) arrives, it is downloaded and transcribed via ElevenLabs Scribe v2 before being stored as message content."

**Step 3: Commit**

```bash
git add .claude/skills/add-voice-transcription-elevenlabs/modify/
git commit -m "feat(skill): add whatsapp integration files for elevenlabs skill"
```

---

### Task 4: Create skill validation tests

**Files:**
- Create: `.claude/skills/add-voice-transcription-elevenlabs/tests/voice-transcription.test.ts`
- Reference: `.claude/skills/add-voice-transcription/tests/voice-transcription.test.ts` (adapt for ElevenLabs)

**Step 1: Write the validation tests**

Adapt the OpenAI skill's test file. Key changes:
- Check manifest for `voice-transcription-elevenlabs` skill name
- Check for `@elevenlabs/elevenlabs-js` dependency instead of `openai`
- Check for `ELEVENLABS_API_KEY` instead of `OPENAI_API_KEY`
- Check transcription.ts for `transcribeWithElevenLabs` instead of `transcribeWithOpenAI`
- Check for `conflicts` containing `voice-transcription`

```typescript
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('voice-transcription-elevenlabs skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: voice-transcription-elevenlabs');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('@elevenlabs/elevenlabs-js');
    expect(content).toContain('ELEVENLABS_API_KEY');
  });

  it('declares conflict with openai voice-transcription skill', () => {
    const content = fs.readFileSync(path.join(skillDir, 'manifest.yaml'), 'utf-8');
    expect(content).toContain('voice-transcription');
    expect(content).toMatch(/conflicts:\s*\n\s*-\s*voice-transcription/);
  });

  it('has all files declared in adds', () => {
    const transcriptionFile = path.join(skillDir, 'add', 'src', 'transcription.ts');
    expect(fs.existsSync(transcriptionFile)).toBe(true);

    const content = fs.readFileSync(transcriptionFile, 'utf-8');
    expect(content).toContain('transcribeAudioMessage');
    expect(content).toContain('isVoiceMessage');
    expect(content).toContain('transcribeWithElevenLabs');
    expect(content).toContain('downloadMediaMessage');
    expect(content).toContain('readEnvFile');
    expect(content).toContain('ElevenLabsClient');
    expect(content).toContain('scribe_v2');
  });

  it('has all files declared in modifies', () => {
    const whatsappFile = path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts');
    const whatsappTestFile = path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts');

    expect(fs.existsSync(whatsappFile)).toBe(true);
    expect(fs.existsSync(whatsappTestFile)).toBe(true);
  });

  it('has intent files for modified files', () => {
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts.intent.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts.intent.md'))).toBe(true);
  });

  it('modified whatsapp.ts preserves core structure', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts'),
      'utf-8',
    );

    expect(content).toContain('class WhatsAppChannel');
    expect(content).toContain('implements Channel');
    expect(content).toContain('async connect()');
    expect(content).toContain('async sendMessage(');
    expect(content).toContain('isConnected()');
    expect(content).toContain('ownsJid(');
    expect(content).toContain('async disconnect()');
    expect(content).toContain('async setTyping(');
    expect(content).toContain('async syncGroupMetadata(');
    expect(content).toContain('private async translateJid(');
    expect(content).toContain('private async flushOutgoingQueue(');
    expect(content).toContain('ASSISTANT_HAS_OWN_NUMBER');
    expect(content).toContain('ASSISTANT_NAME');
    expect(content).toContain('STORE_DIR');
  });

  it('modified whatsapp.ts includes transcription integration', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.ts'),
      'utf-8',
    );

    expect(content).toContain("import { isVoiceMessage, transcribeAudioMessage } from '../transcription.js'");
    expect(content).toContain('isVoiceMessage(msg)');
    expect(content).toContain('transcribeAudioMessage(msg, this.sock)');
    expect(content).toContain('finalContent');
    expect(content).toContain('[Voice:');
    expect(content).toContain('[Voice Message - transcription unavailable]');
    expect(content).toContain('[Voice Message - transcription failed]');
  });

  it('modified whatsapp.test.ts includes transcription mock and tests', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts'),
      'utf-8',
    );

    expect(content).toContain("vi.mock('../transcription.js'");
    expect(content).toContain('isVoiceMessage');
    expect(content).toContain('transcribeAudioMessage');
    expect(content).toContain('transcribes voice messages');
    expect(content).toContain('falls back when transcription returns null');
    expect(content).toContain('falls back when transcription throws');
    expect(content).toContain('[Voice: Hello this is a voice message]');
  });

  it('modified whatsapp.test.ts preserves all existing test sections', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'whatsapp.test.ts'),
      'utf-8',
    );

    expect(content).toContain("describe('connection lifecycle'");
    expect(content).toContain("describe('authentication'");
    expect(content).toContain("describe('reconnection'");
    expect(content).toContain("describe('message handling'");
    expect(content).toContain("describe('LID to JID translation'");
    expect(content).toContain("describe('outgoing message queue'");
    expect(content).toContain("describe('group metadata sync'");
    expect(content).toContain("describe('ownsJid'");
    expect(content).toContain("describe('setTyping'");
    expect(content).toContain("describe('channel properties'");
  });
});
```

**Step 2: Run tests to verify**

```bash
npx vitest run .claude/skills/add-voice-transcription-elevenlabs/tests/voice-transcription.test.ts
```

Expected: All 9 tests pass.

**Step 3: Commit**

```bash
git add .claude/skills/add-voice-transcription-elevenlabs/tests/
git commit -m "feat(skill): add validation tests for elevenlabs skill package"
```

---

### Task 5: Write SKILL.md

**Files:**
- Create: `.claude/skills/add-voice-transcription-elevenlabs/SKILL.md`
- Reference: `.claude/skills/add-voice-transcription/SKILL.md` (adapt for ElevenLabs)

**Step 1: Write the SKILL.md**

Structure matches the OpenAI skill with these changes:
- Description references ElevenLabs Scribe v2 instead of OpenAI Whisper
- Phase 1 asks for ElevenLabs API key (from https://elevenlabs.io/app/settings/api-keys)
- Phase 3 configures `ELEVENLABS_API_KEY` instead of `OPENAI_API_KEY`
- Includes a note about batch vs realtime API modes
- Troubleshooting references ElevenLabs-specific errors
- Env var in .env is `ELEVENLABS_API_KEY`

```markdown
---
name: add-voice-transcription-elevenlabs
description: Add voice message transcription to NanoClaw using ElevenLabs Scribe v2. Automatically transcribes WhatsApp voice notes so the agent can read and respond to them.
---

# Add Voice Transcription (ElevenLabs)

This skill adds automatic voice message transcription to NanoClaw's WhatsApp channel using ElevenLabs' Scribe v2 speech-to-text model. When a voice note arrives, it is downloaded, transcribed, and delivered to the agent as `[Voice: <transcript>]`.

## Batch vs Realtime

ElevenLabs offers two speech-to-text modes:

- **Batch** (`POST /v1/speech-to-text`): Upload a complete audio file, receive the transcript. This is what this skill uses.
- **Realtime** (`wss://...`): WebSocket streaming for live microphone audio.

**This skill uses batch mode.** WhatsApp voice notes arrive as complete audio files — batch is the correct choice. Realtime mode is designed for live audio streams (e.g., microphone input) and adds unnecessary complexity (PCM conversion, WebSocket session management) with no benefit for pre-recorded files. Batch handles any number of files efficiently — whether it's 1 voice note or a burst of several arriving at once, each is processed as a simple HTTP request.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `voice-transcription-elevenlabs` is in `applied_skills`, skip to Phase 3 (Configure). The code changes are already in place.

### Ask the user

1. **Do they have an ElevenLabs API key?** If yes, collect it now. If no, they'll need to create one at https://elevenlabs.io/app/settings/api-keys.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-voice-transcription-elevenlabs
```

This deterministically:
- Adds `src/transcription.ts` (voice transcription module using ElevenLabs Scribe v2)
- Three-way merges voice handling into `src/channels/whatsapp.ts` (isVoiceMessage check, transcribeAudioMessage call)
- Three-way merges transcription tests into `src/channels/whatsapp.test.ts` (mock + 3 test cases)
- Installs the `@elevenlabs/elevenlabs-js` npm dependency
- Updates `.env.example` with `ELEVENLABS_API_KEY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/channels/whatsapp.ts.intent.md` — what changed and invariants for whatsapp.ts
- `modify/src/channels/whatsapp.test.ts.intent.md` — what changed for whatsapp.test.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the 3 new voice transcription tests) and build must be clean before proceeding.

## Phase 3: Configure

### Get ElevenLabs API key (if needed)

If the user doesn't have an API key:

> I need you to create an ElevenLabs API key:
>
> 1. Go to https://elevenlabs.io/app/settings/api-keys
> 2. Click "Create API Key"
> 3. Give it a name (e.g., "NanoClaw Transcription")
> 4. Copy the key
>
> Scribe v2 pricing: see https://elevenlabs.io/pricing for current speech-to-text rates.

Wait for the user to provide the key.

### Add to environment

Add to `.env`:

```bash
ELEVENLABS_API_KEY=<their-key>
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

### Test with a voice note

Tell the user:

> Send a voice note in any registered WhatsApp chat. The agent should receive it as `[Voice: <transcript>]` and respond to its content.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i voice
```

Look for:
- `Transcribed voice message` — successful transcription with character count
- `ELEVENLABS_API_KEY not set` — key missing from `.env`
- `ElevenLabs transcription failed` — API error (check key validity, billing)
- `Failed to download audio message` — media download issue

## Troubleshooting

### Voice notes show "[Voice Message - transcription unavailable]"

1. Check `ELEVENLABS_API_KEY` is set in `.env` AND synced to `data/env/env`
2. Verify key works: `curl -s https://api.elevenlabs.io/v1/user -H "xi-api-key: $ELEVENLABS_API_KEY" | head -c 200`
3. Check ElevenLabs billing — Scribe v2 requires an active subscription or credits

### Voice notes show "[Voice Message - transcription failed]"

Check logs for the specific error. Common causes:
- Network timeout — transient, will work on next message
- Invalid API key — regenerate at https://elevenlabs.io/app/settings/api-keys
- Rate limiting — wait and retry

### Agent doesn't respond to voice notes

Verify the chat is registered and the agent is running. Voice transcription only runs for registered groups.
```

**Step 2: Commit**

```bash
git add .claude/skills/add-voice-transcription-elevenlabs/SKILL.md
git commit -m "feat(skill): add SKILL.md for elevenlabs voice transcription"
```

---

### Task 6: Run all validation tests and verify

**Step 1: Run the skill package tests**

```bash
npx vitest run .claude/skills/add-voice-transcription-elevenlabs/tests/voice-transcription.test.ts
```

Expected: All 9 tests pass.

**Step 2: Verify file structure is complete**

```bash
find .claude/skills/add-voice-transcription-elevenlabs -type f | sort
```

Expected output:
```
.claude/skills/add-voice-transcription-elevenlabs/SKILL.md
.claude/skills/add-voice-transcription-elevenlabs/add/src/transcription.ts
.claude/skills/add-voice-transcription-elevenlabs/manifest.yaml
.claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.test.ts
.claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.test.ts.intent.md
.claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.ts
.claude/skills/add-voice-transcription-elevenlabs/modify/src/channels/whatsapp.ts.intent.md
.claude/skills/add-voice-transcription-elevenlabs/tests/voice-transcription.test.ts
```

**Step 3: Final commit with all files**

If any files weren't committed individually, stage and commit them now.
