---
name: generate-image
description: Generate images from text prompts using Google Gemini AI (Imagen 3 / gemini-2.0-flash). Use when asked to generate, create, draw, or make an image of something. Trigger phrases include "generate an image of...", "create an image of...", "draw me...", "make an image of...".
---

# Image Generation with Google Gemini

## IMPORTANT: File locations and sending

- **Always write files to /home/node/work/** (that directory is writable)
- **You MUST use the `mcp__nanoclaw__send_files` tool** to send the image to the user — do NOT just tell them where the file is
- The `send_files` tool sends the actual image attachment to chat so it appears inline

## Prerequisites

Check for the API key before doing anything:

```bash
if [ -z "$GEMINI_API_KEY" ]; then
  echo "ERROR: GEMINI_API_KEY environment variable is not set."
  echo "Please set your Gemini API key to use image generation."
  exit 1
fi
```

## Workflow

1. Extract the image prompt from the user's message
2. Call the Gemini API with curl
3. Parse the response and decode the base64 image
4. Save to /home/node/work/generated_image.png
5. Send to chat via `mcp__nanoclaw__send_files`

## API Call (gemini-2.5-flash-image)

```bash
PROMPT="a red fox sitting in a snowy forest"
OUTPUT_FILE="/home/node/work/generated_image.png"

# Make the API request and save full response
RESPONSE=$(curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"contents\": [{
      \"parts\": [{
        \"text\": \"${PROMPT}\"
      }]
    }],
    \"generationConfig\": {
      \"responseModalities\": [\"TEXT\", \"IMAGE\"]
    }
  }")

# Extract base64 image data from the response
# The image is in candidates[0].content.parts[].inlineData.data where mimeType is image/png or image/jpeg
IMAGE_B64=$(echo "$RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
parts = data.get('candidates', [{}])[0].get('content', {}).get('parts', [])
for part in parts:
    if 'inlineData' in part:
        print(part['inlineData']['data'])
        break
")

if [ -z "$IMAGE_B64" ]; then
  echo "ERROR: No image returned from Gemini API."
  echo "API Response: $RESPONSE"
  exit 1
fi

# Decode and save
echo "$IMAGE_B64" | base64 -d > "$OUTPUT_FILE"
echo "Image saved to $OUTPUT_FILE"
```

## Fallback: Imagen 3 endpoint

If the gemini-2.0-flash endpoint fails, try the Imagen 3 endpoint:

```bash
PROMPT="a red fox sitting in a snowy forest"
OUTPUT_FILE="/home/node/work/generated_image.png"

RESPONSE=$(curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${GEMINI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"instances\": [{
      \"prompt\": \"${PROMPT}\"
    }],
    \"parameters\": {
      \"sampleCount\": 1
    }
  }")

IMAGE_B64=$(echo "$RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
predictions = data.get('predictions', [])
if predictions:
    print(predictions[0].get('bytesBase64Encoded', ''))
")

if [ -z "$IMAGE_B64" ]; then
  echo "ERROR: No image returned from Imagen 3 API."
  echo "API Response: $RESPONSE"
  exit 1
fi

echo "$IMAGE_B64" | base64 -d > "$OUTPUT_FILE"
echo "Image saved to $OUTPUT_FILE"
```

## Complete Example Script

```bash
#!/bin/bash
set -e

# Check API key
if [ -z "$GEMINI_API_KEY" ]; then
  echo "ERROR: GEMINI_API_KEY is not set. Cannot generate image."
  exit 1
fi

PROMPT="YOUR_PROMPT_HERE"
OUTPUT_FILE="/home/node/work/generated_image.png"

echo "Generating image for prompt: $PROMPT"

# Try gemini-2.5-flash-image first
RESPONSE=$(curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"contents\": [{
      \"parts\": [{\"text\": \"${PROMPT}\"}]
    }],
    \"generationConfig\": {
      \"responseModalities\": [\"TEXT\", \"IMAGE\"]
    }
  }")

IMAGE_B64=$(echo "$RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
parts = data.get('candidates', [{}])[0].get('content', {}).get('parts', [])
for part in parts:
    if 'inlineData' in part:
        print(part['inlineData']['data'])
        break
" 2>/dev/null)

# Fallback to Imagen 3 if no image returned
if [ -z "$IMAGE_B64" ]; then
  echo "Trying Imagen 3 fallback..."
  RESPONSE=$(curl -s -X POST \
    "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${GEMINI_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{
      \"instances\": [{\"prompt\": \"${PROMPT}\"}],
      \"parameters\": {\"sampleCount\": 1}
    }")

  IMAGE_B64=$(echo "$RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
predictions = data.get('predictions', [])
if predictions:
    print(predictions[0].get('bytesBase64Encoded', ''))
" 2>/dev/null)
fi

if [ -z "$IMAGE_B64" ]; then
  echo "ERROR: Image generation failed. Check your GEMINI_API_KEY and try again."
  echo "Last API response: $RESPONSE"
  exit 1
fi

echo "$IMAGE_B64" | base64 -d > "$OUTPUT_FILE"
echo "Image generated successfully: $OUTPUT_FILE"
```

Then call `mcp__nanoclaw__send_files` with:
- files: `[{path: "/home/node/work/generated_image.png", name: "generated_image.png"}]`
- caption: A short description of what was generated (e.g. "Here's your image: a red fox sitting in a snowy forest")

## Error Handling

| Situation | What to do |
|-----------|-----------|
| `GEMINI_API_KEY` not set | Tell the user the API key is missing and they need to configure it |
| API returns 400 | The prompt may have been blocked by safety filters — tell the user and suggest rephrasing |
| API returns 403 | Invalid API key or quota exceeded — tell the user |
| `IMAGE_B64` is empty but no HTTP error | Try the Imagen 3 fallback endpoint |
| `base64 -d` fails | The image data may be corrupt — report the error and show the raw response |

## Notes

- The prompt should be passed exactly as the user wrote it (after stripping the trigger phrase)
- For best results, prompts should be descriptive: include style, lighting, subject details
- Gemini may add a text part alongside the image in the response — that is normal, only extract the `inlineData` parts
- The output file is always overwritten on each generation
- If the user asks for multiple images, generate them sequentially as generated_image_1.png, generated_image_2.png, etc., and send all at once
