---
name: image-gen
description: Generate or edit images using GPT Image. Use special tags in your response — the host processes them and sends the result as a photo.
---

# Image Generation

You can generate and edit images by including special tags in your response. The host intercepts these tags, calls the API, saves the result to your group's `attachments/` directory, and sends the photo to the chat.

## Generate an image

```
[[image: your prompt here]]
```

The host generates an image from the prompt and sends it as a photo. You will see it in the next turn as an attachment if the user replies.

## Edit an existing image

```
[[image-edit: attachments/photo_12345.jpg | describe the changes you want]]
```

The path is relative to your group directory (`/workspace/group/`). Use paths from photos the user sent you or from previously generated images.

## Rules

- One image tag per message. Put it on its own line for clarity.
- Any text outside the tag is sent as a regular text message alongside the photo.
- Tags can be combined with `[[tts]]` — image is processed first, then TTS runs on remaining text.
- Generated images are saved to `attachments/image_<timestamp>.png` in your group directory.
- If generation fails (API error, missing source file), the tag is silently dropped and only the text part is sent.
