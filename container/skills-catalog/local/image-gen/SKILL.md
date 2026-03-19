---
name: image-gen
description: Generate images from text prompts using Google Gemini AI. Use when asked to create, draw, generate, illustrate, or visualize an image. Requires GEMINI_API_KEY environment variable.
---

# Image Generation with Gemini

## Prerequisites

The `GEMINI_API_KEY` environment variable must be set. Always check first:

```bash
if [ -z "${GEMINI_API_KEY}" ]; then
  echo "Error: GEMINI_API_KEY is not set. Please add it to the container environment."
  exit 1
fi
```

## Workflow

1. Check that `GEMINI_API_KEY` is set (fail clearly if not)
2. Call the Gemini API with the user's prompt
3. Extract the base64 image data and decode to PNG
4. Save to `/home/node/work/generated_image.png`
5. Send to chat using `mcp__nanoclaw__send_files`

## Step 1: Call the API

Use `gemini-2.5-flash-image` (free tier supported):

```bash
PROMPT="YOUR_PROMPT"
curl -s -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"contents\":[{\"parts\":[{\"text\":\"Generate an image of: ${PROMPT}\"}]}],\"generationConfig\":{\"responseModalities\":[\"TEXT\",\"IMAGE\"]}}" \
  > /tmp/img_response.json
```

## Step 2: Decode and Save the Image

Always create the output directory first, then extract the image:

```bash
mkdir -p /home/node/work
```

```python
python3 -c "
import json, base64
with open('/tmp/img_response.json') as f:
    r = json.load(f)
if 'error' in r:
    print('API Error:', r['error'].get('message', r['error']))
    exit(1)
parts = r.get('candidates', [{}])[0].get('content', {}).get('parts', [])
for part in parts:
    if 'inlineData' in part:
        img_data = part['inlineData']['data']
        with open('/home/node/work/generated_image.png', 'wb') as out:
            out.write(base64.b64decode(img_data))
        print('Image saved')
        break
else:
    print('No image in response. Full response:')
    print(json.dumps(r, indent=2))
    exit(1)
"
```

## Step 3: Send to Chat

```python
mcp__nanoclaw__send_files(
  files=[{"path": "/home/node/work/generated_image.png", "name": "generated_image.png"}],
  caption="Here's your generated image"
)
```

## Error Handling

Common errors:
- **403 / API key invalid**: `GEMINI_API_KEY` is wrong or not enabled
- **429 / quota exceeded**: Free tier limit reached — wait and retry
- **Safety filter blocked**: The prompt was flagged; rephrase and try again

## Writing Good Prompts

Better prompts produce better images. Be as descriptive as possible:

- **Include subject**: What is the main subject? ("a red fox", "a futuristic city", "a bowl of ramen")
- **Include style**: Photo-realistic, digital painting, oil painting, watercolor, anime, sketch, 3D render
- **Include lighting**: Golden hour, studio lighting, dramatic shadows, soft diffused light
- **Include mood/atmosphere**: Serene, epic, mysterious, warm and cozy, dystopian

**Weak prompt:** "a dog"
**Strong prompt:** "A golden retriever puppy playing in a sunlit meadow full of wildflowers, shallow depth of field, warm afternoon light, photorealistic photography"
