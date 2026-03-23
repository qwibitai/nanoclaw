---
name: image-gen
description: Generate, edit, face-swap images, and text-to-speech using OpenAI and fal.ai
allowed-tools: Bash(generate-image:*),Bash(face-swap:*),Bash(text-to-speech:*)
---

# Image Generation, Editing & Face Swap

You have TWO image tools. Choose the right one:

| Tool | When to use |
|------|-------------|
| `generate-image` | Create images from text, edit/modify photos, combine elements, change styles, add/remove objects |
| `face-swap` | Put someone's FACE onto another person's body/photo. Use ONLY when the user wants to preserve a specific person's face identity |

## Decision guide

- "Ponme en la playa" → `generate-image` (creative edit, face identity doesn't need to be exact)
- "Pon MI CARA en esta foto" / "swap faces" / "quiero verme como X" → `face-swap` (face identity must be preserved)
- "Hazme un logo" / "genera una imagen de..." → `generate-image` (text-to-image)
- "Cambia el fondo" / "quita esto" → `generate-image` (image editing)

## generate-image

```bash
# Text to image
generate-image "a cat floating in space, photorealistic"

# Edit with one image
generate-image "put this person on a tropical beach" /workspace/group/attachments/img-1234.jpg

# Combine multiple images
generate-image "put the person from the first image into the scene of the second image" /workspace/group/attachments/img-1234.jpg /workspace/group/attachments/img-5678.jpg
```

Up to 10 source images supported. Find attachment paths from `[Image: attachments/img-xxx.jpg]` in the conversation.

## face-swap

```bash
# Swap the face from photo 1 onto the person in photo 2
face-swap /workspace/group/attachments/img-FACE.jpg /workspace/group/attachments/img-TARGET.jpg
```

- First argument: the photo with the FACE to use (source face)
- Second argument: the photo where the face will be PLACED (target body/scene)
- Takes ~10-20 seconds to process

## text-to-speech (voice replies)

When the user asks you to respond with voice, or when a voice reply feels natural (e.g. they sent a voice note), generate audio:

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

Do NOT call the OpenAI TTS API directly — always use this script. When generating speech, ALWAYS write the text in Mexican Spanish with natural, casual expressions.

Send as a native voice note:
```
mcp__nanoclaw__send_message({ text: "voice", audio_path: "/workspace/group/tts-123.ogg" })
```

**When to use voice:** Only when the user explicitly asks for audio, or when replying to a voice note and a voice reply feels natural. Default to text.

## Output & delivery

All scripts save to `/workspace/group/` and print the path. Send results as native media:

```
# Image
mcp__nanoclaw__send_message({ text: "Here's your image!", image_path: "/workspace/group/generated-123.png" })

# Voice note
mcp__nanoclaw__send_message({ text: "voice", audio_path: "/workspace/group/tts-123.ogg" })
```

## Important

- Do NOT call curl or APIs directly — always use these scripts
- JPEG input is supported (no need to convert to PNG)
- Do NOT fall back to dall-e-2 or dall-e-3
