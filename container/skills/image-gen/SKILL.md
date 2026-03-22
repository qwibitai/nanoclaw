---
name: image-gen
description: Generate or edit images using OpenAI's gpt-image-1 model
allowed-tools: Bash(generate-image:*)
---

# Image Generation & Editing

ALWAYS use the `generate-image` script for ANY image generation or editing request. Do NOT call the OpenAI API directly or use any other method. The script handles authentication, error handling, and file management.

## Generate from text

```bash
generate-image "a cat floating in space, photorealistic"
```

## Edit an existing image

When the user sends a photo and wants it modified, pass the attachment path:

```bash
generate-image "put this person on a tropical beach" /workspace/group/attachments/img-1234.jpg
```

The source image path comes from the `[Image: attachments/img-xxx.jpg]` reference in the user's message.

## Output

The script saves to `/workspace/group/generated-<timestamp>.png` and prints the path.

## Sending the result to the user

After generating, send it as a native image:

```
mcp__nanoclaw__send_message({ text: "Here's your image!", image_path: "/workspace/group/generated-123.png" })
```

## Important

- The script uses `gpt-image-1` which supports BOTH generation and editing
- Do NOT fall back to dall-e-2 or dall-e-3 — always use this script
- Do NOT call curl or the OpenAI API yourself — use the script
- JPEG input is supported for editing (no need to convert to PNG)
