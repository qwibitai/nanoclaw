---
name: image-gen
description: Generate or edit images using OpenAI's gpt-image-1 model
allowed-tools: Bash(generate-image:*)
---

# Image Generation & Editing

Generate images from text or edit existing images using AI.

## Generate from text

```bash
generate-image "a cat floating in space, photorealistic"
```

## Edit an existing image

```bash
generate-image "put this person on a tropical beach" /workspace/group/incoming-image.png
```

First argument is the prompt. Optional second argument is the source image path.

Output is saved to `/workspace/group/generated-<timestamp>.png`. The script prints the path.

## Sending the result to the user

After generating, send it as a native image (not a link):

```
mcp__nanoclaw__send_message({ text: "Here's your image!", image_path: "/workspace/group/generated-123.png" })
```
