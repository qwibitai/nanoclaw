---
name: speech-to-text
description: Transcribe voice messages and audio files to text. Use immediately when you receive a message containing a voice message or audio file path.
allowed-tools: Bash(transcribe:*)
---

# Speech-to-Text (Gemini)

Transcribe voice messages and audio files using the `transcribe.sh` script.

## When to use

**Always** transcribe immediately when you see a message like:
- `[Voice message: /workspace/group/media/123.ogg]`
- `[Audio: /workspace/group/media/123.mp3]`

Do not ask the user if they want a transcription — just do it, then respond to the content.

## Usage

```bash
/home/node/.claude/skills/speech-to-text/transcribe.sh /workspace/group/media/123.ogg
```

The script prints the transcribed text to stdout. Supported formats: `.ogg`, `.mp3`, `.m4a`, `.wav`, `.flac`, `.webm`.

## Example flow

1. User sends: `[Voice message: /workspace/group/media/456.ogg]`
2. Run `transcribe.sh /workspace/group/media/456.ogg`
3. Read the transcription output
4. Respond to the spoken content naturally
