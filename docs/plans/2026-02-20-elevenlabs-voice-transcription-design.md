# ElevenLabs Voice Transcription Skill Design

## Goal

Create `add-voice-transcription-elevenlabs` skill that mirrors the existing OpenAI `add-voice-transcription` skill, using ElevenLabs' `scribe_v2` model instead of OpenAI Whisper. Conflicts with the OpenAI skill (only one active at a time).

## API Choice: Batch Only

ElevenLabs offers two speech-to-text APIs:

- **Batch** (`POST /v1/speech-to-text`): Upload complete audio file, get transcript back. Simple HTTP request.
- **Realtime** (`wss://api.elevenlabs.io/v1/speech-to-text/realtime`): WebSocket streaming for live audio. Requires PCM conversion, session management, manual commit handling.

WhatsApp voice notes arrive as complete OGG files. Batch is the correct choice. The SKILL.md will clarify to the agent that batch is appropriate for pre-recorded audio files (which is always the case for voice notes), and that realtime is only relevant for live microphone streams.

## Skill Structure

Mirrors the OpenAI skill exactly:

```
add-voice-transcription-elevenlabs/
├── SKILL.md
├── manifest.yaml
├── add/
│   └── src/
│       └── transcription.ts
├── modify/
│   └── src/
│       └── channels/
│           ├── whatsapp.ts
│           ├── whatsapp.ts.intent.md
│           ├── whatsapp.test.ts
│           └── whatsapp.test.ts.intent.md
└── tests/
    └── voice-transcription.test.ts
```

## Key Differences from OpenAI Skill

| Aspect | OpenAI | ElevenLabs |
|--------|--------|------------|
| SDK | `openai` | `@elevenlabs/elevenlabs-js` |
| Model | `whisper-1` | `scribe_v2` |
| Env var | `OPENAI_API_KEY` | `ELEVENLABS_API_KEY` |
| API call | `openai.audio.transcriptions.create()` | `elevenlabs.speechToText.convert()` |
| Auth | Constructor `{ apiKey }` | Constructor `{ apiKey }` |
| Input | `toFile(buffer, 'voice.ogg')` | `new Blob([buffer])` |
| Response | Plain text string | Object with `.text` property |

## transcription.ts Design

```typescript
// Uses ElevenLabs SDK
const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
const client = new ElevenLabsClient({ apiKey });

const audioBlob = new Blob([audioBuffer], { type: 'audio/ogg' });
const result = await client.speechToText.convert({
  file: audioBlob,
  modelId: 'scribe_v2',
  languageCode: null,    // auto-detect
  tagAudioEvents: false, // not useful for voice notes
  diarize: false,        // single speaker
});
return result.text;
```

Same public API surface as OpenAI version: `isVoiceMessage()` and `transcribeAudioMessage()`.

## manifest.yaml

```yaml
skill: voice-transcription-elevenlabs
conflicts: [voice-transcription]  # cannot coexist with OpenAI skill
npm_dependencies:
  "@elevenlabs/elevenlabs-js": "^1.0.0"
env_additions:
  - ELEVENLABS_API_KEY
```

## modify/ Files

Identical to the OpenAI skill's modify/ directory. The whatsapp.ts changes import from `../transcription.js` which is the same module path regardless of provider. Same three-way merge targets, same intent files, same test cases.

## SKILL.md

Four phases matching the OpenAI skill:
1. **Pre-flight**: Check state.yaml, ask for ElevenLabs API key
2. **Apply**: Run apply-skill.ts, validate with tests + build
3. **Configure**: Set ELEVENLABS_API_KEY in .env, sync to container, restart
4. **Verify**: Send voice note, check logs

Includes note explaining batch vs realtime: batch is correct for voice notes (complete files). Realtime is for live audio streams only. Batch processes efficiently whether it's 1 or many files.
