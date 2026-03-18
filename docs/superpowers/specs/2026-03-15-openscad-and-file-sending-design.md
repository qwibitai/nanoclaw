# OpenSCAD Integration & Generic File Sending

## Overview

Add OpenSCAD 3D modeling to the agent container and a generic file-sending IPC mechanism so agents can send rendered images and model archives back through Discord (and future channels).

## Architecture

Three layers, each independently useful:

1. **Generic file-sending IPC** (host) — agents write files + manifest to `/workspace/ipc/files/`, host picks them up and routes to channels
2. **Channel `sendFile()` method** (Discord) — optional method on Channel interface for sending file attachments
3. **OpenSCAD container skill** — installs OpenSCAD in the container, teaches the agent the workflow via SKILL.md

## 1. Generic File-Sending IPC

### IPC Protocol

Agent writes a JSON manifest to `/workspace/ipc/files/`:

```json
{
  "type": "send_files",
  "chatJid": "dc:1256030844355612732",
  "files": [
    { "path": "/workspace/group/render.png", "name": "model.png" },
    { "path": "/workspace/group/model.zip", "name": "model.zip" }
  ],
  "caption": "Here's your 3D model"
}
```

- `path`: absolute path inside the container (must be under a mounted writable directory — `/workspace/group/` or `/workspace/ipc/`)
- `name`: filename presented to the user in Discord
- `caption`: optional text sent alongside the files

### Host-Side Processing

In `src/ipc.ts`, add a `files/` subdirectory scan alongside `messages/` and `tasks/`:

1. Read manifest JSON from `/data/ipc/{group}/files/*.json`
2. Validate each file:
   - Extension must be in the **file type allowlist** (default: `[".png", ".zip"]`)
   - File must exist and be under a valid mount path (no path traversal)
   - File size capped at 25MB (Discord limit)
3. Resolve host paths (container paths map to host mount paths via group folder)
4. Call `channel.sendFile(jid, files, caption)` on the owning channel
5. Delete manifest after processing (same pattern as messages/tasks)

### File Type Allowlist

Stored in `src/config.ts`:

```typescript
export const FILE_SEND_ALLOWLIST = (process.env.FILE_SEND_ALLOWLIST || '.png,.zip')
  .split(',')
  .map(s => s.trim().toLowerCase());
```

Scoped to `.png` and `.zip` for now. Easily extended via env var.

### Path Resolution

Container paths under `/workspace/group/` map to `groups/{folder}/` on host.
Container paths under `/workspace/ipc/` map to `data/ipc/{folder}/` on host.
All other paths are rejected.

### IPC Directory Setup

In `src/container-runner.ts`, add `files` to the IPC subdirectories loop:

```typescript
for (const sub of ['messages', 'tasks', 'input', 'files']) {
```

### MCP Tool

Add `send_files` tool to `container/agent-runner/src/ipc-mcp-stdio.ts`:

```typescript
send_files: {
  description: 'Send files (images, archives) to the chat',
  parameters: {
    files: z.array(z.object({
      path: z.string().describe('Absolute path to file in container'),
      name: z.string().describe('Filename shown to recipient'),
    })),
    caption: z.string().optional().describe('Text sent with the files'),
  }
}
```

Writes to `/workspace/ipc/files/` with `chatJid` injected from env.

## 2. Channel `sendFile()` Method

### Interface Extension

In `src/types.ts`, add optional method to `Channel`:

```typescript
export interface FileAttachment {
  path: string;    // Host filesystem path
  name: string;    // Display filename
}

export interface Channel {
  // ... existing methods ...
  sendFile?(jid: string, files: FileAttachment[], caption?: string): Promise<void>;
}
```

### Discord Implementation

In `src/channels/discord.ts`, implement `sendFile()`:

```typescript
async sendFile(jid: string, files: FileAttachment[], caption?: string): Promise<void> {
  const channelId = jid.replace(/^dc:/, '');
  const channel = await this.client.channels.fetch(channelId);
  const textChannel = channel as TextChannel;

  // Send to active thread if one exists, otherwise to channel
  const threadId = this.getThread(jid);
  const target = threadId
    ? await textChannel.threads.fetch(threadId) || textChannel
    : textChannel;

  await target.send({
    content: caption || undefined,
    files: files.map(f => ({ attachment: f.path, name: f.name })),
  });
}
```

### IPC Deps Extension

Add `sendFile` to `IpcDeps`:

```typescript
export interface IpcDeps {
  // ... existing ...
  sendFile: (jid: string, files: FileAttachment[], caption?: string) => Promise<void>;
}
```

Host-side `sendFile` in `src/index.ts` finds the channel and calls `channel.sendFile()`, falling back to error if channel doesn't support files.

## 3. OpenSCAD Container Skill

### Dockerfile Changes

Add OpenSCAD and xvfb (for headless rendering) to the container:

```dockerfile
RUN apt-get update && apt-get install -y \
    openscad \
    xvfb \
    zip \
    && rm -rf /var/lib/apt/lists/*
```

Add a render wrapper script at `/usr/local/bin/scad-render`:

```bash
#!/bin/bash
# Usage: scad-render <input.scad> [output.png] [--size WxH]
# Renders OpenSCAD file to PNG using xvfb for headless operation
INPUT="$1"
OUTPUT="${2:-${INPUT%.scad}.png}"
SIZE="${3:-1024,1024}"
xvfb-run --auto-servernum openscad -o "$OUTPUT" --imgsize="$SIZE" --render "$INPUT"
```

This wrapper is the extension point — swap it later for an STL pipeline without changing the skill.

### Container Skill (SKILL.md)

At `container/skills/openscad/SKILL.md`:

```markdown
---
name: openscad
description: Create 3D models with OpenSCAD — write .scad files, render to PNG, and send results back to chat. Use when asked to model, design, or create 3D objects.
---

# 3D Modeling with OpenSCAD

## Workflow

1. Write `.scad` file(s) in the working directory
2. Render to PNG: `scad-render model.scad render.png`
3. Zip the source: `zip model.zip *.scad`
4. Send to chat using the `send_files` MCP tool

## Example

[... OpenSCAD syntax reference and examples ...]
```

### Workspace

Agent writes `.scad` files to `/workspace/group/` (the group's writable directory). Renders and zips happen there too. The `send_files` MCP tool reads from that path.

## File Flow

```
Agent writes model.scad to /workspace/group/
  ↓
Agent runs: scad-render model.scad render.png
  ↓
Agent runs: zip model.zip *.scad
  ↓
Agent calls MCP send_files tool with [render.png, model.zip]
  ↓
MCP server writes manifest to /workspace/ipc/files/
  ↓
Host IPC watcher reads manifest, resolves paths, validates extensions
  ↓
Host calls channel.sendFile(jid, files, caption)
  ↓
Discord sends attachments to thread/channel
```

## Security

- File extension allowlist prevents arbitrary file exfiltration (default: `.png`, `.zip`)
- Path validation ensures files come from mounted directories only
- 25MB size cap per file (Discord limit)
- Same authorization model as messages: non-main groups can only send to their own chat
- No new network access — OpenSCAD runs entirely offline

## Testing

- Unit test for path resolution and allowlist validation
- Manual test: `@NanoClaw create a model of a coke can` should produce a PNG preview and ZIP in Discord

## Files Changed

| File | Change |
|------|--------|
| `container/Dockerfile` | Add openscad, xvfb, zip, scad-render script |
| `container/skills/openscad/SKILL.md` | New skill teaching agent OpenSCAD workflow |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `send_files` MCP tool |
| `src/types.ts` | Add `FileAttachment` interface, optional `sendFile` to Channel |
| `src/ipc.ts` | Add files/ directory processing with allowlist validation |
| `src/channels/discord.ts` | Implement `sendFile()` method |
| `src/container-runner.ts` | Add `files` to IPC subdirectory setup |
| `src/config.ts` | Add `FILE_SEND_ALLOWLIST` config |
| `src/index.ts` | Wire `sendFile` into IPC deps |
| `.claude/skills/add-openscad/SKILL.md` | New add-* skill for setup |
