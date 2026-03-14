# fal.ai Image Generation (Flux 2 Flash)

Generate images from text or edit existing images using fal.ai's Flux 2 Flash endpoints, then send them directly to the user via WhatsApp.

## Endpoint Selection

| Situation | Endpoint |
|-----------|----------|
| User wants a new image from a text description | `fal-ai/flux-2/flash` (text-to-image) |
| User provides image URL(s) and wants edits | `fal-ai/flux-2/flash/edit` (image-to-image) |

## Prompt Enhancement

Always enhance prompts for best quality:
- **Prefix:** `masterpiece, award-winning design, best quality, highly detailed, hyper-realistic, `
- **Suffix:** `, 8k, 16k`

Flux 2 Flash has **no `negative_prompt` field** — omit it entirely.

## Image Size Mapping

| User says | `image_size` value |
|-----------|-------------------|
| No preference (text-to-image) | `landscape_4_3` |
| No preference (image edit) | `square_hd` |
| "vertical" / "portrait" | `portrait_16_9` |
| "horizontal" / "landscape" | `landscape_16_9` |
| "square" | `square_hd` |

## Text-to-Image Example

```bash
RESPONSE=$(curl -s -X POST \
  "https://fal.run/fal-ai/flux-2/flash" \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "masterpiece, award-winning design, best quality, highly detailed, hyper-realistic, a sunset over the ocean, 8k, 16k",
    "image_size": "landscape_16_9",
    "num_inference_steps": 4,
    "num_images": 1,
    "enable_safety_checker": true
  }')

IMAGE_URL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['images'][0]['url'])")
```

## Image-to-Image (Edit) Example

```bash
RESPONSE=$(curl -s -X POST \
  "https://fal.run/fal-ai/flux-2/flash/edit" \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "masterpiece, best quality, highly detailed, convert to black and white, 8k, 16k",
    "image_url": "https://example.com/original-image.jpg",
    "image_size": "square_hd",
    "num_inference_steps": 4,
    "num_images": 1,
    "enable_safety_checker": true
  }')

IMAGE_URL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['images'][0]['url'])")
```

## Editing a WhatsApp Attachment

When a user sends a WhatsApp image, NanoClaw saves it locally and the message includes a path like:
```
[Image saved: /workspace/group/attachments/1234567890.jpg]
```

WhatsApp CDN URLs expire and require auth — they cannot be passed directly to fal.ai. You must upload the local file to fal.ai storage first to get a stable public URL:

```bash
# Step 1: Upload to fal.ai storage
FAL_IMAGE_URL=$(curl -s -X POST \
  "https://storage.fal.run/upload" \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: image/jpeg" \
  -H "x-fal-file-name: attachment.jpg" \
  --data-binary @/workspace/group/attachments/1234567890.jpg \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])")

# Step 2: Edit with fal.ai
RESPONSE=$(curl -s -X POST \
  "https://fal.run/fal-ai/flux-2/flash/edit" \
  -H "Authorization: Key $FAL_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"prompt\": \"masterpiece, best quality, highly detailed, convert to black and white, 8k, 16k\",
    \"image_url\": \"$FAL_IMAGE_URL\",
    \"image_size\": \"square_hd\",
    \"num_inference_steps\": 4,
    \"num_images\": 1,
    \"enable_safety_checker\": true
  }")

IMAGE_URL=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['images'][0]['url'])")
```

## Sending the Result

After extracting the URL, send the image with the exact prompt used as caption in a code block. Return only the image and the prompt — no other text:

```
send_image(url=IMAGE_URL, caption="```\n<exact prompt sent to fal.ai>\n```")
```

The caption must contain only the prompt in a code block. No greetings, no commentary, no extra text.

## Error Handling

If the request fails (non-200 or missing `images` key), check:
1. `$FAL_KEY` is set (`echo $FAL_KEY`)
2. The response body for an `error` field
3. That image URLs passed to the edit endpoint are publicly accessible

## Pricing

~$0.005 per megapixel (~$0.005 for a 1024×1024 image).
