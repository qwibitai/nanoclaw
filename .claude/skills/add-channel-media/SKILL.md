---
name: add-channel-media
description: Add universal media support to all channels — lazy download, send/receive images/docs/audio/video via container MCP tools.
---

# Add Channel Media Support

This skill adds media attachment handling (images, video, audio, documents) across all channels. The architecture uses lazy download — inbound media stores only a reference; the container agent downloads on demand via MCP tools.

## Architecture Overview

```
Inbound:  Channel → processInboundMedia() → MediaRef (disk) + MediaAttachment (message)
                                                  ↓
Agent:    Sees <attachment id="..." /> in message XML
          Calls get_media(id) MCP tool
          → IPC request → Host downloads from channel → File appears in /workspace/media/
          Agent reads file with Read tool

Outbound: Agent creates file under /workspace/
          Calls send_media(path) MCP tool
          → IPC request → Host reads file + routes through channel.sendMedia()
```

Key design decisions:
- **Lazy download**: Media refs are stored immediately (fast), actual bytes downloaded only when agent requests
- **Ref isolation**: Download secrets (WhatsApp keys, Slack auth URLs) stored in `data/media-refs/` — never mounted into containers
- **Per-group media**: Each group gets isolated `data/media/{folder}/` mounted at `/workspace/media/`

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `channel-media` is in `applied_skills`, the code changes are already in place — skip to Phase 3.

### Check current state

Verify the codebase has:
- `src/types.ts` with Channel interface (needed for sendMedia/downloadMedia methods)
- `src/ipc.ts` with processTaskIpc function
- `container/agent-runner/src/ipc-mcp-stdio.ts` with MCP server tools

## Phase 2: Apply Code Changes

### New files (add/)

Copy these files directly — they are entirely new:

| Source | Destination |
|--------|-------------|
| `add/src/media.ts` | `src/media.ts` |
| `add/src/media.test.ts` | `src/media.test.ts` |

### Modified files (modify/)

For each file in `modify/`, apply the changes described in the corresponding `.intent.md` file. The modify/ directory contains the complete target version of each file. The intent docs explain what changed and why, for conflict resolution.

Changes are listed in dependency order — apply in this order:

#### 1. src/types.ts — Media interfaces + Channel methods
- Add `MediaAttachment` interface (id, filename, mimetype, size)
- Add `MediaSendOptions` interface (caption, filename, mimetype)
- Add `attachments?: MediaAttachment[]` to `NewMessage`
- Add `sendMedia?()` and `downloadMedia?()` to `Channel` interface

#### 2. src/config.ts — Media directory config
- Add `MEDIA_DIR = path.resolve(DATA_DIR, 'media')`
- Add `MAX_MEDIA_SIZE` (env-configurable, default 50MB)
- Place after `DATA_DIR`, before `CONTAINER_IMAGE`

#### 3. src/db.ts — Attachments storage
- Add `attachments TEXT` column migration (safe ALTER TABLE with try/catch)
- Update `storeMessage()` — add attachments JSON to INSERT
- Update `storeMessageDirect()` — add attachments parameter + INSERT
- Update `getNewMessages()` — SELECT attachments, parse JSON on read
- Update `getMessagesSince()` — SELECT attachments, parse JSON on read

#### 4. src/router.ts — Attachment formatting
- Update `formatMessages()` to append `<attachment>` XML elements for messages with attachments

#### 5. src/container-runner.ts — Media mount
- Import `MEDIA_DIR` from config
- Add per-group media directory mount in `buildVolumeMounts()`:
  - Host: `data/media/{group.folder}/`
  - Container: `/workspace/media/` (read-write)

#### 6. container/Dockerfile — Workspace directory
- Add `/workspace/media` to the `mkdir -p` line

#### 7. container/agent-runner/src/ipc-mcp-stdio.ts — MCP media tools
- Add `get_media` tool — downloads attachment via IPC, polls for file
- Add `send_media` tool — sends file to chat via IPC
- Place after `register_group` tool, before transport initialization

#### 8. src/ipc.ts — Media IPC handlers
- Import `resolveContainerMediaPath` from media module
- Import `MediaSendOptions` from types
- Add `sendMedia` and `downloadMedia` to `IpcDeps` interface
- Add `media_download` case to processTaskIpc
- Add `media_message` case to processTaskIpc (with authorization check)
- Add media fields to processTaskIpc data type

#### 9. src/index.ts — Media wiring
- Import media functions: `getMediaRef`, `getExtFromMime`, `guessMimetype`, `saveMediaFile`
- Add `sendMedia` IPC dep: route through channel.sendMedia with text fallback
- Add `downloadMedia` IPC dep: look up ref, find channel, download buffer, save file

### Update test files

#### src/formatting.test.ts
- Add test suite "formatMessages with attachments" covering:
  - Single attachment with size
  - Multiple attachments
  - Size omitted when undefined
  - Special character escaping in attributes
  - Mixed text and media message ordering

#### src/ipc-auth.test.ts
- Add `sendMedia: async () => {}` and `downloadMedia: async () => {}` to deps mock

#### src/container-runner.test.ts
- Add `MEDIA_DIR: '/tmp/nanoclaw-test-data/media'` to config mock

### Add media support to channel skills

This core skill adds the media infrastructure (types, IPC, MCP tools, storage). Each channel skill must implement `sendMedia()` and `downloadMedia()` on its Channel to actually handle media. Without these, the channel falls back to sending a text message.

For each applied channel skill, update its channel implementation:
- Import `processInboundMedia` from media module for inbound media detection
- Implement `downloadMedia(ref)` using the channel's native API
- Implement `sendMedia(jid, filePath, options)` routing by MIME type
- Call `processInboundMedia()` in the message handler for media messages

When updating channel test files for media support:
- Add `DATA_DIR`, `MEDIA_DIR`, `MAX_MEDIA_SIZE` to the `../config.js` mock
- Mock `../media.js` module (`processInboundMedia`) to avoid filesystem operations in tests
- Update media handler test contexts to include media-type-specific properties (e.g., `photo` array, `video`/`voice`/`audio`/`document`/`sticker` objects on `ctx.message`)
- Update test expectations: media messages now return `attachments` array and content comes from `processInboundMedia` (caption or `[Type]` label), not hardcoded placeholders

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean.

## Phase 3: Rebuild Container

The container needs to be rebuilt to include the new MCP tools:

```bash
./container/build.sh
```

If using Apple Container, use the appropriate build command.

### Delete cached agent-runner source

Each group caches its own copy of the agent-runner TypeScript source in `data/sessions/*/agent-runner-src/`. After rebuilding the container, these **must** be deleted so they get regenerated from the new image on the next run. If skipped, containers will keep using the old MCP tools (without `get_media`/`send_media`), and agents will fall back to Bash workarounds that don't work.

```bash
find data/sessions -name agent-runner-src -type d -exec rm -rf {} +
```

## Phase 4: Verify

### Test inbound media

1. Send an image to a registered group via each installed channel with media support
2. Check logs for "processInboundMedia" — ref should be stored
3. The agent should see `<attachment id="..." />` in the message
4. If the agent calls `get_media`, verify the file appears in `data/media/{group}/`

### Test outbound media

1. Ask the agent to create and send a file (e.g., "create a simple chart and send it to me")
2. The agent should use `send_media` MCP tool
3. Verify the file arrives in the chat

### Check media isolation

Verify `data/media-refs/` exists (refs with download secrets) and is NOT mounted into containers. Only `data/media/{group}/` (downloaded files) is mounted.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_MEDIA_SIZE` | `52428800` (50MB) | Maximum media file size in bytes |

## Troubleshooting

### Media not appearing in messages
1. Check that `src/media.ts` is imported correctly (ESM `.js` extension)
2. Verify the `attachments` column exists: `sqlite3 store/messages.db ".schema messages"`
3. Check `data/media-refs/{group}/` for stored refs

### get_media timeout
1. Check IPC directory is mounted correctly in container
2. Verify the host IPC watcher is processing `media_download` type
3. Check channel's `downloadMedia()` is implemented
4. Check logs for "Media download failed" errors

### send_media not delivered
1. Verify file exists under `/workspace/` in the container
2. Check IPC `media_message` files are being created
3. Verify channel's `sendMedia()` is implemented
4. Check logs for "Media send failed" or "Unauthorized media send attempt"

### Container missing /workspace/media/
1. Rebuild container: `./container/build.sh`
2. Verify Dockerfile includes `/workspace/media` in mkdir line
