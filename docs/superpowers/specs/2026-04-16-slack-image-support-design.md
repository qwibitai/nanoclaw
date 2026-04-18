# Slack Image Support — Design

**Date:** 2026-04-16
**Status:** Draft
**Author:** micko.cabacungan@gmail.com (with Claude)

## Goal

Enable the NanoClaw agent ("Edna") to both **receive** and **send** images (one or many) through the Slack channel, with the plumbing shaped so WhatsApp, Telegram, Discord, and future channels can slot in for ~50 lines of channel-specific code each.

Inbound images become multimodal content blocks in the agent's turn input (the agent "sees" them). Outbound images are sent via an explicit MCP tool the agent calls, supporting both single-image messages and multi-image albums.

## Non-Goals

- PDFs, audio, video, or any non-image attachments. Images only.
- Image generation. Agents may produce images through their own tools (e.g. diagrams, scripts writing PNGs); this spec only delivers what already exists on disk.
- Retroactive support for channels other than Slack. The abstractions are designed so other channels can adopt them, but only Slack gets a working implementation in this spec.
- Reusing the existing `add-image-vision` skill branch. That skill is WhatsApp-specific and not installed in this tree. The Slack work stands alone; if/when image-vision is later installed, the two converge on the shared `src/image.ts` helper and `ImageAttachment` type.

## Architecture

### Data model additions (in `src/types.ts`)

```ts
export interface ImageAttachment {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string; // base64, already resized + encoded by the inbound channel
}

export interface NewMessage {
  // ...existing fields...
  images?: ImageAttachment[]; // populated by channels that received images
}

export interface Channel {
  // ...existing methods...
  sendImage?(jid: string, imagePaths: string[], caption?: string): Promise<void>;
}
```

`sendImage` is **optional** on the Channel interface. Channels that don't implement it degrade gracefully at the orchestrator level (see Outbound §4).

`ImageAttachment.data` is base64 already, not a raw buffer. The channel is responsible for downloading, resizing, and encoding before it reaches the orchestrator, so the rest of the system handles uniform data.

### Shared helper: `src/image.ts`

New module, channel-agnostic. Owns:

- `processImageBuffer(buffer, mimeType): Promise<ImageAttachment>` — resizes via `sharp` (long-edge ≤ 1568px, JPEG quality 85) and base64-encodes. Returns `null` if the image can't be decoded or is still too large after resize (≥ 5MB, the Anthropic API per-image ceiling).
- `isSupportedImageMime(mime): boolean` — whitelist: jpeg/png/gif/webp.

Numbers (1568px, q85, 5MB) match what the existing `add-image-vision` skill branch uses for WhatsApp. Keeping them consistent means the two channels will produce comparable inputs to Claude.

**New runtime dependency:** `sharp`. Native bindings require build tools — already a known cost from the existing image-vision skill, and documented in this project's troubleshooting.

Unit tests cover: resize-down path, no-op path (already small), mime detection, oversize-after-resize rejection, invalid-buffer rejection.

## Inbound Pipeline

```
Slack → slack.ts → onMessage → orchestrator → container spawn → agent-runner → Claude
            ↓                      ↓              ↓               ↓
          files[]            NewMessage      ContainerInput   MessageStream.push
          fetched            .images         .images          → content blocks
```

### 1. Slack reception (`src/channels/slack.ts`)

**Change at `slack.ts:80`** (the early-return guard):

```ts
// before
if (!msg.text) return;
// after
if (!msg.text && !msg.files?.length) return;
```

**After existing text/user resolution**, before emitting to `onMessage`:

```ts
const images: ImageAttachment[] = [];
for (const file of msg.files ?? []) {
  if (!file.mimetype || !isSupportedImageMime(file.mimetype)) continue;
  try {
    const res = await fetch(file.url_private_download!, {
      headers: { Authorization: `Bearer ${botToken}` },
    });
    if (!res.ok) {
      logger.warn({ fileId: file.id, status: res.status }, 'Slack image fetch failed');
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const att = await processImageBuffer(buf, file.mimetype);
    if (att) images.push(att);
  } catch (err) {
    logger.warn({ fileId: file.id, err }, 'Slack image processing failed');
  }
}
// Include images on the NewMessage. Non-image files are ignored (logged, not delivered).
this.opts.onMessage(jid, { /* existing fields */, images: images.length ? images : undefined });
```

Notes:

- `botToken` is already in scope as the constructor captures it from `.env`. It must be passed to the SlackChannel instance (stored on `this`) since `url_private_download` requires it as a bearer header.
- Slack delivers files in `msg.files[]`; multi-image messages are native, no special handling.
- Non-image files (PDFs, docs) are silently dropped with a debug log. Future work could surface them, but out of scope here.

### 2. Orchestrator passthrough (`src/index.ts`)

The message loop already funnels the `NewMessage` object into the container spawn path. Extend whatever object is sent to `container-runner.ts` to include `images` if present. No logic change beyond the carrier.

### 3. Container spawn (`src/container-runner.ts`)

`ContainerInput` (defined both host-side and in `container/agent-runner/src/index.ts`) gains:

```ts
interface ContainerInput {
  // ...existing fields...
  images?: ImageAttachment[];
}
```

The JSON written to container stdin just grows this field. No new mount, no new plumbing.

**Note on type duplication:** `ContainerInput` is declared in both `src/container-runner.ts` (host) and `container/agent-runner/src/index.ts` (container) because the container has no build-time access to the host's types. The two declarations must both gain `images?: ImageAttachment[]` and stay in sync. A shared package could fix this long-term but is out of scope for this spec.

### 4. IPC follow-up messages (mid-turn)

Currently, IPC follow-ups at `/workspace/ipc/input/*.json` have shape `{ type: "message", text: "..." }`. Extend to:

```ts
{ type: "message", text: "...", images?: ImageAttachment[] }
```

`drainIpcInput()` at `container/agent-runner/src/index.ts:311` changes its return type from `string[]` to `Array<{ text: string; images?: ImageAttachment[] }>`. Call sites that treat the return as plain strings (notably the `messages.join('\n')` at `index.ts:359` and the similar join at `index.ts:667`) are updated to preserve images per-message.

The host-side writer of these IPC files (the slack.ts path when a message arrives during an active container session) includes images in the written JSON.

### 5. Multimodal push in agent-runner (`container/agent-runner/src/index.ts`)

`MessageStream.push` at line 76:

```ts
// before
push(text: string): void { ... content: text ... }

// after
push(text: string, images?: ImageAttachment[]): void {
  const content = images?.length
    ? [
        ...images.map(img => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
        })),
        { type: 'text' as const, text },
      ]
    : text;
  this.queue.push({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: '',
  });
  this.waiting?.();
}
```

The Agent SDK's user-message `content` field accepts either `string` or an array of content blocks, so this is a clean extension.

## Outbound Pipeline

```
Agent → MCP send_image → IPC file → host watcher → orchestrator sendImage → Slack.sendImage → files.uploadV2
```

Symmetric to inbound, templated on the existing `send_message` MCP tool at `container/agent-runner/src/ipc-mcp-stdio.ts:42`.

### 1. MCP tool `send_image` (`container/agent-runner/src/ipc-mcp-stdio.ts`)

```ts
server.tool(
  'send_image',
  "Send one or more images to the user or group. Images must already exist as files inside your group workspace (/workspace/group/**). Pass a single path or an array of up to 10 paths for an album (one message, multiple images). Optional caption appears with the image(s).",
  {
    path: z.union([z.string(), z.array(z.string()).min(1).max(10)])
      .describe('Path(s) to image file(s). Relative paths resolve against /workspace/group/. Absolute paths must be inside /workspace/group/; paths outside are rejected.'),
    caption: z.string().optional().describe('Optional caption shown with the image(s)'),
  },
  async (args) => {
    const rawPaths = Array.isArray(args.path) ? args.path : [args.path];
    const resolved: string[] = [];
    for (const p of rawPaths) {
      const abs = path.resolve('/workspace/group', p);
      if (!abs.startsWith('/workspace/group/')) {
        return { isError: true, content: [{ type: 'text' as const, text: `Path escapes group workspace: ${p}` }] };
      }
      if (!fs.existsSync(abs)) {
        return { isError: true, content: [{ type: 'text' as const, text: `File not found: ${p}` }] };
      }
      resolved.push(path.relative('/workspace/group', abs));
    }
    writeIpcFile(path.join(IPC_DIR, 'images'), {
      type: 'image',
      chatJid,
      groupFolder,
      paths: resolved, // relative to group workspace; host resolves against groups/{folder}/
      caption: args.caption,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `${resolved.length} image(s) queued for delivery.` }] };
  },
);
```

Security:

- Path validation rejects `..` traversal via `path.resolve` + prefix check.
- Bounded batch size (max 10) mirrors Slack's practical album size.
- Allowed tool list in `container/agent-runner/src/index.ts:453` gains `'mcp__nanoclaw__send_image'` (implicit via the existing `'mcp__nanoclaw__*'` wildcard — the implementation plan should `grep` to confirm the wildcard is still present before relying on it).

### 2. Host watcher extension (`src/ipc.ts`)

`startIpcWatcher`'s per-group scan loop at `ipc.ts:62` adds a third directory alongside `messagesDir`/`tasksDir`:

```ts
const imagesDir = path.join(ipcBaseDir, sourceGroup, 'images');
```

Processing mirrors the existing messages handler at `ipc.ts:69-110`:

```ts
if (fs.existsSync(imagesDir)) {
  const imageFiles = fs.readdirSync(imagesDir).filter(f => f.endsWith('.json'));
  for (const file of imageFiles) {
    const filePath = path.join(imagesDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (data.type === 'image' && data.chatJid && Array.isArray(data.paths) && data.paths.length) {
        const targetGroup = registeredGroups[data.chatJid];
        if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
          // Resolve each path against the source group's host-side workspace
          const groupRoot = path.join(GROUPS_DIR, sourceGroup); // e.g., groups/slack_general
          const absolute: string[] = [];
          for (const rel of data.paths) {
            const abs = path.resolve(groupRoot, rel);
            if (!abs.startsWith(groupRoot + path.sep)) {
              logger.warn({ rel, sourceGroup }, 'IPC image path escapes group root, skipped');
              continue;
            }
            if (!fs.existsSync(abs)) {
              logger.warn({ abs, sourceGroup }, 'IPC image file missing on host, skipped');
              continue;
            }
            absolute.push(abs);
          }
          if (absolute.length) {
            await deps.sendImage(data.chatJid, absolute, data.caption);
            logger.info({ chatJid: data.chatJid, count: absolute.length, sourceGroup }, 'IPC image delivered');
          }
        } else {
          logger.warn({ chatJid: data.chatJid, sourceGroup }, 'Unauthorized IPC image attempt blocked');
        }
      }
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.error({ file, sourceGroup, err }, 'Error processing IPC image');
      const errorDir = path.join(ipcBaseDir, 'errors');
      fs.mkdirSync(errorDir, { recursive: true });
      fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
    }
  }
}
```

Authorization is identical to messages: main group can target any jid, other groups can only target their own.

`GROUPS_DIR` is the existing host-side groups directory (imported from `config.ts` if not already in `ipc.ts`).

### 3. `IpcDeps` extension

```ts
export interface IpcDeps {
  // ...existing fields...
  sendImage: (jid: string, paths: string[], caption?: string) => Promise<void>;
}
```

### 4. Orchestrator-level `sendImage` (`src/router.ts`)

Add a `routeOutboundImage(channels, jid, paths, caption?)` function alongside the existing `routeOutbound` at `router.ts:44`. The parallel structure keeps all cross-channel outbound routing in one module. Behavior:

1. Look up the channel owning `jid`: `channels.find(c => c.ownsJid(jid) && c.isConnected())`.
2. If `channel.sendImage` is defined → call it.
3. If not → log a warning and fall back to `channel.sendMessage(jid, caption ?? '[image]')` so the user at least sees the caption and the agent's intent isn't silently lost.

`src/index.ts` wires `routeOutboundImage` into the `IpcDeps.sendImage` callback passed to the IPC watcher, exactly as it wires `sendMessage` today.

This is the degradation path that lets us roll Slack out without breaking channels that haven't implemented images yet.

### 5. Slack implementation (`src/channels/slack.ts`)

```ts
async sendImage(jid: string, imagePaths: string[], caption?: string): Promise<void> {
  const channelId = jid.replace(/^slack:/, '');

  if (!this.connected) {
    this.outgoingQueue.push({ kind: 'image', jid, imagePaths, caption });
    logger.info({ jid, count: imagePaths.length }, 'Slack disconnected, image queued');
    return;
  }

  try {
    await this.app.client.files.uploadV2({
      channel_id: channelId,
      initial_comment: caption,
      file_uploads: imagePaths.map(p => ({
        file: fs.createReadStream(p),
        filename: path.basename(p),
      })),
    });
    logger.info({ jid, count: imagePaths.length }, 'Slack image(s) sent');
  } catch (err) {
    this.outgoingQueue.push({ kind: 'image', jid, imagePaths, caption });
    logger.warn({ jid, err }, 'Failed to send Slack image, queued');
  }
}
```

The existing `outgoingQueue` is retyped from `Array<{ jid; text }>` to a discriminated union:

```ts
private outgoingQueue: Array<
  | { kind: 'text'; jid: string; text: string }
  | { kind: 'image'; jid: string; imagePaths: string[]; caption?: string }
> = [];
```

`flushOutgoingQueue` branches on `kind` to call either `chat.postMessage` or `files.uploadV2`.

Slack's `files.uploadV2` handles single vs. multiple files transparently — one file is a single image message, multiple files land as a single message with all images attached (album UX).

## Error Handling & Edge Cases

| Case | Behavior |
|------|----------|
| Inbound image fetch fails (network/auth) | Logged, that image is dropped. Message still delivered with remaining images + text. |
| Inbound image decode fails (corrupt/unknown format) | Logged, dropped. Remaining images delivered. |
| Inbound image too large after resize | Logged, dropped. Remaining images delivered. |
| Inbound message has only a failed image and no text | Revert to existing silent drop. If nothing survives (no text AND no successfully-processed images), the message is not delivered to `onMessage`. |
| Image queued for later Slack upload, but agent deletes the file | Upload fails on reconnect; item re-queued in a loop or logged and dropped. Queued image uploads depend on the source file surviving until flush — the agent should not delete files it has just handed to `send_image` until confirmation. |
| MCP tool path escapes `/workspace/group/` | Tool returns `isError: true`; no IPC file written. |
| MCP tool file doesn't exist | Tool returns `isError: true`; no IPC file written. |
| Host watcher finds IPC-declared file missing | Skip that path, continue with the rest. If all missing, move IPC file to `errors/`. |
| Host watcher: IPC path escapes group root | Skip, log (defense in depth; tool already validates). |
| Channel has no `sendImage` | Warn, fall back to sending caption as text. |
| Slack upload fails (network/API) | Re-queue in `outgoingQueue`, flushed on reconnect. |
| Slack disconnected at send time | Queue the image item (file path captured — agent's file still exists on disk). |

**Queue persistence:** The existing `outgoingQueue` is in-memory only. An image queued while disconnected is lost if the host process restarts. This matches current text-message behavior — out of scope to improve here.

**File lifecycle:** The MCP tool does NOT delete the file after queuing. The host watcher does NOT delete the file after upload. The agent's group workspace (`groups/{folder}/`) is the agent's to manage. If outboxes grow unbounded, the agent can clean them up via normal file tools. Rationale: explicit cleanup is the agent's concern, not the plumbing's.

## Testing

| Test | Location | Coverage |
|------|----------|----------|
| `src/image.test.ts` (new) | unit | resize-down, no-op-small, mime detection, oversize rejection, invalid buffer |
| `src/channels/slack.test.ts` (extend) | unit | inbound files-only message, mixed text+files, unsupported mime skipped, fetch failure continues, `sendImage` single, `sendImage` multi, `sendImage` queues when disconnected |
| `src/ipc.test.ts` (extend, or new if absent) | unit | images dir processed, path-escape rejected, missing-file skipped, unauthorized cross-group rejected, success deletes IPC file, failure moves to errors |
| MCP tool validation | unit | `send_image` rejects `..` paths, rejects missing files, accepts valid single and array inputs |
| `MessageStream.push` content-block shape | unit (agent-runner) | With images: produces array content with correct `type: 'image'` + base64 source + trailing text block. Without images: produces plain-string content. Catches accidental regressions in multimodal wiring. |
| Manual end-to-end | Slack channel | Send photo to Edna → agent describes it. Ask agent to send back an image file → arrives in Slack. Ask for multiple images → arrive as an album. |

## File-Level Change Summary

**New files:**
- `src/image.ts` — shared helper for resize + base64.
- `src/image.test.ts` — unit tests for the helper.
- `docs/superpowers/specs/2026-04-16-slack-image-support-design.md` — this spec.

**Modified files:**
- `src/types.ts` — `ImageAttachment`, `NewMessage.images`, `Channel.sendImage`.
- `src/channels/slack.ts` — inbound files handler, `sendImage` method, queue type widening, capture `botToken` on the instance.
- `src/channels/slack.test.ts` — new tests.
- `src/index.ts` — forward `images` into `ContainerInput`; implement orchestrator-level `sendImage` that dispatches to channels with graceful fallback.
- `src/router.ts` — may absorb the orchestrator-level `sendImage` instead of `index.ts`, TBD by the plan.
- `src/container-runner.ts` — extend `ContainerInput` passthrough.
- `src/ipc.ts` — images dir watcher + path validation; extend `IpcDeps` with `sendImage`.
- `src/ipc.test.ts` — new tests.
- `container/agent-runner/src/index.ts` — `ContainerInput.images`; `MessageStream.push` multimodal; `drainIpcInput()` return shape widening; IPC input file shape widening.
- `container/agent-runner/src/ipc-mcp-stdio.ts` — new `send_image` tool.
- `package.json` — add `sharp` dependency.

**Rebuild required:** Yes. `./container/build.sh` rebuilds the container image after agent-runner changes. Per the `add-image-vision` skill, group caches also need `cp container/agent-runner/src/*.ts data/sessions/*/agent-runner-src/` before restart.

## Rollout Considerations

- **Slack app permissions:** The Slack app needs `files:read` (for inbound `url_private_download`) and `files:write` (for `files.uploadV2`) OAuth scopes. If not already granted, user must re-install the app in the workspace. Setup skill (`/add-slack`) should be updated in a follow-up to request these scopes for new installs, but is out of scope for this spec.
- **Backward compatibility:** Existing text-only Slack behavior is unchanged. Channels without image support continue to work unchanged. The `images` field on `NewMessage` is optional everywhere.
- **Breaking changes:** None for user-facing behavior. The `MessageStream.push` signature and `drainIpcInput()` return type change are internal to the container; no external contract changes.
