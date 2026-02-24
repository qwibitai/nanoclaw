# Lazy Media Content Handling

## Problem

Images, voice messages, documents, and other media received via channels are currently discarded or replaced with placeholder text (`[Photo]`, `[Video]`, etc.). The agent never sees the actual content.

## Design Principle: Lazy Retrieval

Media must NOT be downloaded eagerly. Instead:

1. The channel extracts **metadata** (type, filename, size, mime type) and passes it as a structured placeholder in the message text
2. The agent sees the metadata and decides whether it needs the content
3. If it does, it calls a **custom MCP tool** (`fetch_media`) to retrieve the actual bytes
4. The tool downloads the media on demand, returns it as base64 image content (for images) or saves to disk and returns a file path (for large files)

This avoids downloading every photo in a busy group chat when the agent may not need any of them.

## How Custom Tools Work in the Agent SDK

The Claude Agent SDK supports custom tools via **in-process MCP servers** using `createSdkMcpServer()` and the `tool()` helper. These are declared at `query()` time via the `mcpServers` option:

```typescript
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const mediaServer = createSdkMcpServer({
  name: 'media',
  version: '1.0.0',
  tools: [
    tool('fetch_media', 'Download media attachment by reference ID', {
      mediaRef: z.string().describe('Media reference ID from message placeholder'),
    }, async (args) => {
      // ... download and return content
    }),
  ],
});

for await (const message of query({
  prompt: stream,
  options: {
    mcpServers: {
      media: mediaServer,           // in-process, no child process needed
      nanoclaw: { command: 'node', args: [mcpServerPath], env: { ... } },
    },
    allowedTools: [
      'mcp__nanoclaw__*',
      'mcp__media__fetch_media',    // whitelist the new tool
      // ... other tools
    ],
  },
}));
```

Tool results can return image content blocks directly per the MCP spec:

```typescript
return {
  content: [{
    type: 'image',
    data: base64EncodedData,
    mimeType: 'image/jpeg',
  }]
};
```

**However:** NanoClaw currently uses a **stdio MCP server** (`ipc-mcp-stdio.ts`) spawned as a child process, not an in-process SDK server. The two approaches can coexist — the media tools could use either approach. The stdio approach is better if the tool needs host-side access (e.g., downloading via host network); the in-process SDK approach is simpler if the download can happen inside the container.

## Architecture

### Message Flow

```
Channel (WhatsApp/Telegram/Slack)
  │
  │  receives message with media
  │
  ▼
Extract metadata (NO download)
  │  - media type (image/video/audio/document)
  │  - file name, file size, mime type
  │  - channel-specific reference ID
  │  - caption text (if any)
  │
  ▼
Store as structured placeholder in message content
  │  e.g. "[Image: sunset.jpg, 2.4MB, image/jpeg, ref:wa_media_abc123] Beautiful sunset"
  │
  ▼
Agent receives message text with placeholders
  │
  │  Agent decides: "I need to see this image"
  │
  ▼
Agent calls: mcp__media__fetch_media({ mediaRef: "wa_media_abc123" })
  │
  ▼
MCP tool handler:
  │  1. Looks up ref in media registry
  │  2. Downloads from channel API (WhatsApp/Telegram/etc)
  │  3. For images: returns base64 content block (MCP image type)
  │  4. For large files: saves to /workspace/group/media/, returns file path
  │
  ▼
Agent sees the image / reads the file
```

### Data Structures

**Media reference** — stored in a registry so the tool can look it up later:

```typescript
interface MediaReference {
  id: string;                    // unique ref ID (e.g. "wa_media_abc123")
  channel: 'whatsapp' | 'telegram' | 'slack';
  chatJid: string;
  messageId: string;
  mediaType: 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'voice';
  mimeType: string;
  fileName?: string;
  fileSize?: number;             // bytes, if known
  caption?: string;
  // Channel-specific download info
  downloadInfo: Record<string, unknown>;
  //   WhatsApp: { message: proto.IWebMessageInfo }  (Baileys message object for downloadMediaMessage)
  //   Telegram: { fileId: string }                   (for bot.api.getFile())
  //   Slack:    { url: string, token: string }       (file URL with auth header)
  createdAt: string;
  ttl: number;                   // auto-expire after N minutes to free memory
}
```

**Placeholder format** in message text:

```
[{MediaType}: {fileName}, {fileSize}, {mimeType}, ref:{id}]{caption ? " " + caption : ""}
```

Examples:
- `[Image: sunset.jpg, 2.4MB, image/jpeg, ref:wa_3EB0A1B2] Beautiful sunset`
- `[Voice: 12s, audio/ogg, ref:tg_AgACAgI] `
- `[Document: report.pdf, 847KB, application/pdf, ref:sl_F07B2C3D]`

### Components

#### 1. Media Registry (host side)

New file: `src/media-registry.ts`

In-memory map of media references with TTL-based expiry. Written to the group's IPC directory as JSON so the container can access it.

```typescript
// Host side — manages references, writes to IPC
class MediaRegistry {
  private refs = new Map<string, MediaReference>();

  register(ref: MediaReference): string;  // returns ref ID
  get(id: string): MediaReference | undefined;
  prune(): void;  // remove expired entries
  writeToIpc(groupFolder: string): void;  // serialize to /workspace/ipc/media_refs.json
}
```

#### 2. Channel Extractors (per channel)

Each channel extracts metadata without downloading. Changes per channel:

**WhatsApp** (`src/channels/whatsapp.ts`):
- `msg.message?.imageMessage` has: `mimetype`, `fileLength`, `caption`, `fileSha256`
- `msg.message?.documentMessage` has: `mimetype`, `fileLength`, `fileName`, `caption`
- `msg.message?.audioMessage` has: `mimetype`, `fileLength`, `seconds`
- `msg.message?.videoMessage` has: `mimetype`, `fileLength`, `caption`, `seconds`
- The full `msg` object must be retained in `downloadInfo` for later use with Baileys' `downloadMediaMessage()`
- Currently line 175-180 only extracts caption text; needs to also detect media messages and generate placeholder + registry entry

**Telegram** (`telegram.ts` from skill):
- `ctx.message.photo` array — last element is highest resolution, has `file_id`, `file_size`, `width`, `height`
- `ctx.message.document` has `file_id`, `file_name`, `file_size`, `mime_type`
- `ctx.message.voice` has `file_id`, `duration`, `file_size`
- Download via `ctx.api.getFile(fileId)` then fetch the file URL
- Currently line 150 stores `[Photo]` placeholder; needs structured placeholder with ref

**Slack** (from PR #423):
- Files attached to messages via `event.files[]` — each has `id`, `name`, `size`, `mimetype`, `url_private`
- Download via HTTP GET with `Authorization: Bearer {token}` header

#### 3. Media Fetch MCP Tool (container side)

Added to the existing `ipc-mcp-stdio.ts` MCP server (or as a new companion server). Two tools:

**`fetch_media`** — retrieves media content:

```typescript
server.tool(
  'fetch_media',
  'Download a media attachment by its reference ID. Returns image content for images, or saves to disk and returns file path for large files.',
  { mediaRef: z.string().describe('Media reference ID from message placeholder (e.g. wa_3EB0A1B2)') },
  async (args) => {
    // 1. Read media_refs.json from IPC directory
    // 2. Write fetch request to IPC (like send_message pattern)
    // 3. Wait for host to download and write result to IPC
    // 4. For images < 1MB: return { type: 'image', data: base64, mimeType }
    // 5. For large files: host saves to /workspace/group/media/, return file path
  }
);
```

**`list_media`** — shows available media in current conversation:

```typescript
server.tool(
  'list_media',
  'List all available media attachments in recent messages with their reference IDs and metadata.',
  {},
  async () => {
    // Read media_refs.json, return formatted list
  }
);
```

#### 4. Host-Side Download Handler

The host process monitors IPC for media fetch requests (same pattern as `send_message`). When the container requests a download:

1. Look up the `MediaReference` by ID
2. Call the channel-specific download function:
   - WhatsApp: `downloadMediaMessage(msg)` from Baileys
   - Telegram: `bot.api.getFile(fileId)` → fetch URL
   - Slack: HTTP GET with bearer token
3. Write the result back to IPC:
   - Images < 1MB: write base64 to IPC response file
   - Larger files: save to `groups/{folder}/media/{filename}` and write the path

### Size Limits and Constraints

| Constraint | Limit | Handling |
|---|---|---|
| MCP image content block | ~1MB practical limit | Images > 1MB saved to disk instead |
| WhatsApp media | Up to 16MB (images), 64MB (video) | Large files always saved to disk |
| Telegram file download | Up to 20MB via Bot API | Large files saved to disk |
| Media reference TTL | Configurable, default 30 minutes | WhatsApp media URLs expire; Telegram file_id is permanent |
| Memory (registry) | Pruned on TTL | Prevents unbounded growth |

> **Note:** WhatsApp media URLs expire relatively quickly. The Baileys `downloadMediaMessage()` function handles re-fetching the decryption keys, but the original message object must be retained. For Telegram, `file_id` is permanent and can be fetched at any time.

### What Changes Where

| File | Change |
|---|---|
| `src/media-registry.ts` | **New** — in-memory registry with TTL, IPC serialization |
| `src/channels/whatsapp.ts` | Extract media metadata, register refs, emit structured placeholders instead of discarding |
| `.claude/skills/add-telegram/add/src/channels/telegram.ts` | Same for Telegram |
| Slack channel (PR #423) | Same for Slack |
| `src/container-runner.ts` | Write `media_refs.json` to IPC dir before container launch |
| `src/ipc.ts` | Handle `fetch_media` IPC requests, perform downloads, write results |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `fetch_media` and `list_media` tools |
| `src/types.ts` | Add `MediaReference` interface |

### What Does NOT Change

- The `ContainerInput` interface (prompt stays as string with embedded placeholders)
- The agent runner's `query()` call structure (MCP server already declared)
- The `allowedTools` list (already uses `mcp__nanoclaw__*` wildcard)
- Container mounts or isolation model
- Credential handling

## References

- [Claude Agent SDK — Custom Tools](https://platform.claude.com/docs/en/agent-sdk/custom-tools)
- [Claude Agent SDK — MCP](https://platform.claude.com/docs/en/agent-sdk/mcp)
- [MCP Specification — Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Claude Vision Docs](https://platform.claude.com/docs/en/build-with-claude/vision)
