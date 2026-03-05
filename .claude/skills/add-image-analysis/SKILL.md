# Skill: add-image-analysis

Adds automatic image analysis to NanoClaw's WhatsApp channel using a local VLM
(Vision Language Model). When a user sends an image or sticker, it is analysed
by the VLM and the description is delivered to the agent as `[Bildanalyse: <description>]`.

If the user adds a caption to the image, the caption becomes the question asked of the VLM.

No cloud API keys required. All images stay on your machine.

## Prerequisites

A local VLM server compatible with the OpenAI chat completions API (vision-capable).
Recommended: Qwen3-VL via vLLM or Ollama.

```bash
# Example with vLLM:
vllm serve Qwen/Qwen2.5-VL-7B-Instruct --port 8089

# Example with Ollama:
ollama serve
ollama pull qwen2.5vl:7b
# Note: Ollama uses port 11434 by default, set VLM_URL accordingly
```

The server must support the `/v1/chat/completions` endpoint with `image_url` content type.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VLM_URL` | `http://localhost:8089` | Base URL of the VLM server |
| `VLM_MODEL` | `qwen3-vl-8b` | Model name to use |

## Implementation

### 1. Add constants to `src/channels/whatsapp.ts`

```typescript
const VLM_URL = process.env.VLM_URL || 'http://localhost:8089';
const VLM_MODEL = process.env.VLM_MODEL || 'qwen3-vl-8b';
const VLM_TIMEOUT_MS = 60_000;
```

### 2. Add `describeImageWithVLM()` function to `src/channels/whatsapp.ts`

```typescript
async function describeImageWithVLM(
  imageBuffer: Buffer,
  mimeType: string,
  userPrompt?: string,
): Promise<string | null> {
  const ext = mimeType.includes('webp')
    ? 'image/webp'
    : mimeType.includes('png')
      ? 'image/png'
      : 'image/jpeg';
  const b64 = imageBuffer.toString('base64');
  const dataUrl = `data:${ext};base64,${b64}`;

  const prompt =
    userPrompt?.trim() ||
    'Beschreibe kurz was du auf diesem Bild siehst. Antworte auf Deutsch in maximal 3 Sätzen.';

  const body = JSON.stringify({
    model: VLM_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: prompt },
        ],
      },
    ],
    max_tokens: 500,
    temperature: 0.1,
    stream: false,
  });

  return new Promise((resolve) => {
    const url = new URL('/v1/chat/completions', VLM_URL);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ message?: { content?: string } }>;
            };
            resolve(parsed.choices?.[0]?.message?.content?.trim() || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.setTimeout(VLM_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}
```

Note: Uses Node's `http` module directly (not `fetch`) to avoid base64 size issues
with large images. Add `import http from 'http';` to the imports if not already present.

### 3. Add image handler in `messages.upsert` in `src/channels/whatsapp.ts`

In the message processing block, after the audio transcription block, add:

```typescript
// Analyse images/stickers via VLM
if (normalized.imageMessage || normalized.stickerMessage) {
  const imgMsg = normalized.imageMessage || normalized.stickerMessage;
  const group = groups[chatJid];
  try {
    const imgBuffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;
    const mimeType = imgMsg?.mimetype || 'image/jpeg';
    const caption = normalized.imageMessage?.caption?.trim() || '';

    // Caption becomes the VLM question if present
    const vlmResult = await describeImageWithVLM(imgBuffer, mimeType, caption || undefined);

    if (vlmResult) {
      content = caption
        ? `${caption}\n[Bildanalyse: ${vlmResult}]`
        : `[Bildanalyse: ${vlmResult}]`;
    } else {
      // Fallback: save image to disk for the agent to access
      const ext = mimeType.includes('webp') ? 'webp' : 'jpg';
      const mediaDir = path.join(STORE_DIR, '..', 'groups', group.folder, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });
      const filename = `img-${Date.now()}.${ext}`;
      fs.writeFileSync(path.join(mediaDir, filename), imgBuffer);
      const containerPath = `/workspace/group/media/${filename}`;
      content = caption
        ? `${caption}\n[Bild gespeichert unter: ${containerPath}]`
        : `[Bild gespeichert unter: ${containerPath}]`;
    }
  } catch (err) {
    logger.warn({ err, chatJid }, 'Failed to download/process image');
  }
}
```

### 4. Update CLAUDE.md files

Add to `groups/global/CLAUDE.md`:

```markdown
## Bildnachrichten

Wenn der Nutzer ein Bild schickt, hat Nanoclaw es bereits automatisch per VLM analysiert.
Die Analyse kommt in zwei Formen an:

- Bild ohne Prompt: `[Bildanalyse: <Beschreibung des Bildinhalts>]`
- Bild mit Frage/Prompt: `<Frage>\n[Bildanalyse: <VLM-Antwort auf die Frage>]`

Du siehst das Bild NICHT direkt — die VLM-Analyse ist deine einzige Bildquelle.
Antworte natürlich auf Basis der Analyse — sage NICHT "laut Bildanalyse..." o.ä.
```

### 5. Build and restart

```bash
npm run build
systemctl --user restart nanoclaw  # Linux
# or: launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

## Notes

- `add-document-analysis` depends on this skill for PDF and presentation analysis via VLM
- The VLM prompt defaults to German ("Beschreibe..."). Change the default prompt in
  `describeImageWithVLM()` for other languages.
- For stickers (WebP format), the same pipeline applies — stickers are just WebP images.

## Troubleshooting

- **No image analysis, fallback to disk**: VLM server is not reachable. Check `VLM_URL`.
- **Slow analysis**: Normal for 7B+ models on CPU. Use a GPU for production use.
- **Wrong model**: Set `VLM_MODEL` env var to match your running model name exactly.
