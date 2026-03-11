# Intent: src/channels/discord.test.ts (add-discord-voice-transcription)

## What changed

Added mock for `transcribeAudioBuffer` and 3 new audio test cases.

## New mock (added before imports)

```typescript
vi.mock('../transcription.js', () => ({
  transcribeAudioBuffer: vi.fn().mockResolvedValue('Hello from voice'),
}));
```

## New import (after mocks)

```typescript
import { transcribeAudioBuffer } from '../transcription.js';
```

## New test cases (inside 'attachments' describe block)

- Added: `'transcribes audio attachment via transcribeAudioBuffer'`
  → mocks fetch + transcribeAudioBuffer, expects `[Voice: Hello from voice]`
- Added: `'falls back when transcription returns null'`
  → `transcribeAudioBuffer` returns null, expects `[Voice Message - transcription unavailable]`
- Added: `'falls back when audio fetch fails'`
  → fetch throws, expects `[Voice Message - transcription failed]`

## Invariants (must preserve)

- All image tests (from add-discord-image-vision) unchanged
- Video and file placeholder tests unchanged
- All connection, sendMessage, ownsJid, setTyping tests unchanged
- @mention and reply context tests unchanged
