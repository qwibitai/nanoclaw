---
name: voice
description: Text-to-speech voice replies using OpenAI TTS HD
allowed-tools: Bash(text-to-speech:*)
---

# Voice Replies

When the user asks you to respond with voice, or when replying to a voice note and a voice reply feels natural, generate audio:

```bash
# Male voice (default)
text-to-speech "Hola, aquí tienes tu resumen de hoy" male

# Female voice
text-to-speech "Hola, aquí tienes tu resumen de hoy" female
```

Choose male or female based on:
- If the user asks for a specific gender voice → use that
- If responding to a female user or the context calls for it → use female
- Default → male

Send as a native voice note:
```
mcp__nanoclaw__send_message({ text: "voice", audio_path: "/workspace/group/tts-123.ogg" })
```

## Important

- Do NOT call the OpenAI TTS API directly — always use this script
- When generating speech, ALWAYS write the text in Mexican Spanish with natural, casual expressions
- Only use voice when explicitly asked or when replying to a voice note. Default to text.
