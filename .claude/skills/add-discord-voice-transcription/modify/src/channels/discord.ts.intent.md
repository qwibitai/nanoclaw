# Intent: src/channels/discord.ts (add-discord-voice-transcription)

## What changed

Added audio transcription for Discord audio attachments. When an audio file
arrives in a registered channel, it is fetched from the Discord CDN and
transcribed via `transcribeAudioBuffer` (channel-agnostic whisper.cpp call).
Delivered as `[Voice: transcript]` or fallback strings on failure.

## New import

```typescript
import { transcribeAudioBuffer } from '../transcription.js';
```

## Attachment changes (audio branch)

- `audio/*` → `fetch(att.url)` → buffer → `transcribeAudioBuffer(buffer)`
  - Transcript returned: `[Voice: ${transcript}]`
  - Null result: `[Voice Message - transcription unavailable]`
  - Fetch or transcription error: `[Voice Message - transcription failed]`

## Invariants (must preserve)

- Image processing (from add-discord-image-vision) unchanged
- `video/*` and other file placeholders unchanged
- All non-attachment message handling unchanged
- `sendMessage`, `setTyping`, `connect`, `disconnect`, `ownsJid` — all unchanged
