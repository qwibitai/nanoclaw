---
name: add-image-generation
description: Add image generation capabilities to NanoClaw using OpenAI's DALL-E API. Agents can generate images from text descriptions and send them back to WhatsApp as media messages.
---

# Add Image Generation

This skill adds image generation capabilities to NanoClaw using OpenAI's DALL-E API. When users request images, the agent generates them and sends them back as WhatsApp image messages.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Prerequisites

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool** to present this:

> You'll need an OpenAI API key for DALL-E image generation.
>
> Get one at: https://platform.openai.com/api-keys
>
> Cost: ~$0.04 per image (DALL-E 3 standard 1024x1024)
>
> If you already have an OpenAI API key (e.g., from voice transcription), you can reuse it.
>
> Do you have your API key ready?

Wait for user confirmation and the key.

---

## Implementation

### Step 1: Add OpenAI Dependency

Read `package.json` and check if `openai` is already in dependencies (it may be from the voice transcription skill).

If not present, add it:

```json
"dependencies": {
  ...existing dependencies...
  "openai": "^4.77.0"
}
```

Then install:

```bash
npm install
```

### Step 2: Add API Key to Environment

If not already present in `.env`:

```bash
echo "OPENAI_API_KEY=<key_from_user>" >> .env
```

### Step 3: Create Image Generation Tool Script

Create `container/agent-runner/src/tools/generate-image.ts`:

```typescript
/**
 * Image generation tool for NanoClaw agents.
 * Called by the agent to generate images via DALL-E.
 * Writes the image to the IPC directory for the host to pick up and send.
 */
import fs from 'fs';
import path from 'path';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

interface GenerateImageParams {
  prompt: string;
  size?: '1024x1024' | '1024x1792' | '1792x1024';
  quality?: 'standard' | 'hd';
}

export async function generateImage(params: GenerateImageParams): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set. Add it to your .env file.');
  }

  const { prompt, size = '1024x1024', quality = 'standard' } = params;

  // Call OpenAI API directly (no SDK dependency needed inside container)
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size,
      quality,
      response_format: 'b64_json',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`DALL-E API error: ${response.status} ${error}`);
  }

  const data = await response.json();
  const b64Image = data.data[0].b64_json;
  const revisedPrompt = data.data[0].revised_prompt;

  // Write image to IPC directory for host to send
  const ipcDir = '/workspace/ipc';
  const imagesDir = path.join(ipcDir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const imageId = `img-${Date.now()}`;
  const imagePath = path.join(imagesDir, `${imageId}.png`);
  const metadataPath = path.join(imagesDir, `${imageId}.json`);

  // Write the image file
  fs.writeFileSync(imagePath, Buffer.from(b64Image, 'base64'));

  // Write metadata for the host to pick up
  fs.writeFileSync(metadataPath, JSON.stringify({
    type: 'image',
    imageId,
    imagePath: imagePath,
    prompt: revisedPrompt || prompt,
    size,
    quality,
    timestamp: new Date().toISOString(),
  }));

  return `Image generated successfully. Revised prompt: "${revisedPrompt || prompt}"`;
}
```

### Step 4: Register as IPC Tool

Read `container/agent-runner/src/ipc-mcp.ts` and add the image generation tool to the MCP server's tool list:

```typescript
{
  name: 'generate_image',
  description: 'Generate an image from a text description using DALL-E 3. The image will be sent to the chat.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Detailed description of the image to generate',
      },
      size: {
        type: 'string',
        enum: ['1024x1024', '1024x1792', '1792x1024'],
        description: 'Image dimensions. 1024x1024 (square), 1024x1792 (portrait), 1792x1024 (landscape). Default: 1024x1024',
      },
      quality: {
        type: 'string',
        enum: ['standard', 'hd'],
        description: 'Image quality. hd costs more but produces more detailed images. Default: standard',
      },
    },
    required: ['prompt'],
  },
}
```

Add the handler in the tool call processing section:

```typescript
case 'generate_image': {
  const { generateImage } = await import('./tools/generate-image.js');
  const result = await generateImage(args as any);
  return { content: [{ type: 'text', text: result }] };
}
```

### Step 5: Add Image Sending to IPC Watcher

Read `src/index.ts` and find the `processIpcFiles` function inside `startIpcWatcher`.

Add an image processing section after the messages processing block:

```typescript
// Process images from this group's IPC directory
try {
  const imagesDir = path.join(ipcBaseDir, sourceGroup, 'images');
  if (fs.existsSync(imagesDir)) {
    const imageMetaFiles = fs.readdirSync(imagesDir).filter(f => f.endsWith('.json'));
    for (const file of imageMetaFiles) {
      const metaPath = path.join(imagesDir, file);
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.type === 'image' && meta.imagePath) {
          const imageBuffer = fs.readFileSync(meta.imagePath);

          // Find the chat JID for this group
          const chatJid = Object.entries(registeredGroups).find(
            ([, group]) => group.folder === sourceGroup,
          )?.[0];

          if (chatJid) {
            await sock.sendMessage(chatJid, {
              image: imageBuffer,
              caption: meta.prompt ? `Generated: ${meta.prompt}` : undefined,
            });
            logger.info({ sourceGroup, imageId: meta.imageId }, 'Image sent via IPC');
          }

          // Clean up
          fs.unlinkSync(meta.imagePath);
          fs.unlinkSync(metaPath);
        }
      } catch (err) {
        logger.error({ file, sourceGroup, err }, 'Error processing IPC image');
        fs.unlinkSync(metaPath).catch?.(() => {});
      }
    }
  }
} catch (err) {
  logger.error({ err, sourceGroup }, 'Error reading IPC images directory');
}
```

### Step 6: Pass API Key to Container

Read `src/container-runner.ts` and find the `allowedVars` array in `buildVolumeMounts`. Add `OPENAI_API_KEY`:

```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
```

### Step 7: Update Group Memory

Append to `groups/CLAUDE.md`:

```markdown

## Image Generation

You can generate images using the `generate_image` tool (via IPC/MCP):
- Provide a detailed text description
- Choose size: square (1024x1024), portrait (1024x1792), or landscape (1792x1024)
- Choose quality: standard or hd

The generated image will be sent directly to the chat. Use this when users ask you to create, draw, generate, or visualize something.
```

Also append the same section to `groups/main/CLAUDE.md`.

### Step 8: Rebuild and Restart

Rebuild the container (agent runner code changed):

```bash
cd container && ./build.sh
```

Compile TypeScript:

```bash
cd .. && npm run build
```

Restart:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 9: Test

Tell the user:

> Image generation is ready! Test it by sending:
>
> `@Andy generate an image of a sunset over mountains`
>
> The agent will use DALL-E 3 to generate the image and send it directly to the chat.

Monitor logs:

```bash
tail -f logs/nanoclaw.log | grep -i image
```

---

## Cost Management

Monitor usage in your OpenAI dashboard: https://platform.openai.com/usage

| Model | Size | Quality | Cost |
|-------|------|---------|------|
| DALL-E 3 | 1024x1024 | standard | $0.040 |
| DALL-E 3 | 1024x1024 | hd | $0.080 |
| DALL-E 3 | 1024x1792 | standard | $0.080 |
| DALL-E 3 | 1792x1024 | hd | $0.120 |

Tips:
- Default to `standard` quality unless user requests high detail
- Set spending limits in OpenAI account settings

---

## Troubleshooting

### "OPENAI_API_KEY not set"

- Verify the key is in `.env`
- Check that `OPENAI_API_KEY` is in the `allowedVars` array in `container-runner.ts`
- Rebuild the container

### Images not appearing in chat

- Check IPC image directory: `ls data/ipc/main/images/`
- Verify the IPC watcher picks up images in the logs
- Check WhatsApp connection is active

### "content_policy_violation" error

DALL-E has content policies. The agent should modify the prompt and retry, or inform the user the request was blocked.

---

## Removing Image Generation

1. Remove `OPENAI_API_KEY` from `.env` (unless used by other features)

2. Remove `OPENAI_API_KEY` from `allowedVars` in `src/container-runner.ts`

3. Delete `container/agent-runner/src/tools/generate-image.ts`

4. Remove the `generate_image` tool from `container/agent-runner/src/ipc-mcp.ts`

5. Remove the image processing block from `startIpcWatcher` in `src/index.ts`

6. Remove "Image Generation" sections from `groups/*/CLAUDE.md`

7. Rebuild:
   ```bash
   cd container && ./build.sh && cd ..
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
