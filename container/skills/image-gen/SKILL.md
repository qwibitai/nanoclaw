---
name: image-gen
description: Generate images using Google Gemini. Use when the user asks you to create, draw, or generate an image, picture, illustration, or artwork.
allowed-tools: Bash(generate-image:*), mcp__nanoclaw__send_photo
---

# Image Generation (Gemini)

Generate images via the Gemini API using the `generate-image.sh` script.

## Usage

```bash
/home/node/.claude/skills/image-gen/generate-image.sh "a cat wearing a top hat" [aspect_ratio] [size]
```

- **prompt** (required): Description of the image to generate
- **aspect_ratio** (optional): `1:1` (default), `16:9`, `9:16`, `4:3`, `3:4`
- **size** (optional): `small`, `medium` (default), `large`

The script saves the image to `/workspace/group/media/generated/{timestamp}.png` and prints the file path.

## After generating

Always send the image to the user with the `send_photo` MCP tool:

```
send_photo(file_path="/workspace/group/media/generated/{timestamp}.png", caption="Description of the image")
```

## Example flow

1. User asks "draw me a sunset over the ocean"
2. Run `generate-image.sh "a sunset over the ocean"`
3. Script outputs the saved file path
4. Call `send_photo` with that path and a caption
