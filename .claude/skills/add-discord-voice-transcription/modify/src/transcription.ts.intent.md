# Intent: src/transcription.ts (add-discord-voice-transcription)

## What changed

Exposed the inner buffer-level transcription function as a public export so
channels other than WhatsApp (e.g. Discord) can transcribe audio without
depending on Baileys download logic.

## Key change

The private `transcribeWithWhisperCpp(audioBuffer)` function was renamed and
exported as `transcribeAudioBuffer(audioBuffer)`:

```typescript
export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
): Promise<string | null>
```

The existing `transcribeAudioMessage(msg, sock)` now calls `transcribeAudioBuffer`
internally after downloading the Baileys media — behavior is identical.

## Invariants (must preserve)

- `transcribeAudioMessage(msg: WAMessage, sock: WASocket)` signature unchanged
- `isVoiceMessage(msg: WAMessage)` unchanged
- Fallback string `'[Voice Message - transcription unavailable]'` unchanged
- ffmpeg conversion logic unchanged
- whisper-cli execution unchanged
- Temp file cleanup unchanged
- WhatsApp tests continue passing without modification
