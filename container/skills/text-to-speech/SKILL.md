---
name: text-to-speech
description: Generate voice audio from text. Use after responding to voice messages to also send a spoken reply.
allowed-tools: Bash(synthesize:*), mcp__nanoclaw__send_voice
---

# Text-to-Speech (Gemini)

Generate spoken audio from text using the `synthesize.sh` script, then send it as a voice message.

## When to use

After you respond to a transcribed voice message, **also** generate and send a voice reply so the user gets both text and audio.

- If your text response is short/moderate (<~300 words), speak the entire response
- If your text response is long (>~300 words), write a shorter spoken summary instead of TTS-ing the whole thing

**Always send the text response first**, then the voice reply.

## Usage

```bash
/home/node/.claude/skills/text-to-speech/synthesize.sh "Hello, how are you today?"
```

Or pipe text via stdin:
```bash
echo "Hello, how are you today?" | /home/node/.claude/skills/text-to-speech/synthesize.sh
```

The script prints the output file path (OGG Opus format) to stdout.

## After generating

Send the audio to the user with the `send_voice` MCP tool:

```
send_voice(file_path="/workspace/group/media/generated/1234567890.ogg")
```

## Example flow

1. User sends a voice message, you transcribe it with speech-to-text
2. Respond to the content with a text message (via `send_message` or your normal output)
3. Run `synthesize.sh "Your spoken response here"`
4. Script outputs the saved file path
5. Call `send_voice` with that path
