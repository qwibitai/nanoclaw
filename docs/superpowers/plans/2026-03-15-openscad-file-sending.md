# OpenSCAD & Generic File Sending Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable agents to send file attachments (images, archives) back through Discord, and add OpenSCAD 3D modeling to the container.

**Architecture:** Three layers built bottom-up: (1) types & config, (2) IPC file processing on host + MCP tool in container, (3) Discord sendFile, (4) OpenSCAD in Dockerfile + container skill, (5) add-openscad setup skill.

**Tech Stack:** TypeScript, discord.js, OpenSCAD, xvfb, MCP SDK (zod)

**Spec:** `docs/superpowers/specs/2026-03-15-openscad-and-file-sending-design.md`

---

## Task 1: Types & Config

Add `FileAttachment` interface, optional `sendFile` to `Channel`, and file allowlist config.

**Files:**
- Modify: `src/types.ts:82-93`
- Modify: `src/config.ts:73` (append)

- [ ] **Step 1: Add FileAttachment and sendFile to types.ts**

In `src/types.ts`, add `FileAttachment` before the `Channel` interface, and add `sendFile?` to `Channel`:

```typescript
// Before Channel interface (around line 80)
export interface FileAttachment {
  path: string;  // Host filesystem path
  name: string;  // Display filename
}

// Add to Channel interface after syncGroups:
  // Optional: send file attachments. Channels that support it implement it.
  sendFile?(jid: string, files: FileAttachment[], caption?: string): Promise<void>;
```

- [ ] **Step 2: Add FILE_SEND_ALLOWLIST to config.ts**

Append to end of `src/config.ts`:

```typescript
// Allowlist of file extensions agents can send back to channels.
// Scoped narrowly by default; extend via env var.
export const FILE_SEND_ALLOWLIST = (
  process.env.FILE_SEND_ALLOWLIST || '.png,.zip'
)
  .split(',')
  .map((s) => s.trim().toLowerCase());
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: Clean compile, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/config.ts
git commit -m "feat: add FileAttachment type and file send allowlist config"
```

---

## Task 2: IPC File Processing on Host

Add `files/` directory scanning to IPC watcher with path resolution, allowlist validation, and authorization.

**Files:**
- Modify: `src/ipc.ts:13-25` (IpcDeps interface), `src/ipc.ts:61-147` (processIpcFiles loop)
- Modify: `src/container-runner.ts` (IPC subdirectory loop)
- Modify: `src/index.ts:632-650` (wire sendFile into IPC deps)

- [ ] **Step 1: Add sendFile to IpcDeps in ipc.ts**

In `src/ipc.ts`, add to the `IpcDeps` interface (after line 14):

```typescript
  sendFile: (jid: string, files: Array<{ path: string; name: string }>, caption?: string) => Promise<void>;
```

- [ ] **Step 2: Add resolveContainerPath helper**

Add this helper function after the `IpcDeps` interface in `src/ipc.ts`:

```typescript
/**
 * Resolve a container path to a host path.
 * Container /workspace/group/ → groups/{folder}/
 * Container /workspace/ipc/  → data/ipc/{folder}/
 * Returns null if the path is outside allowed mounts.
 */
function resolveContainerPath(
  containerPath: string,
  groupFolder: string,
): string | null {
  const groupPrefix = '/workspace/group/';
  const ipcPrefix = '/workspace/ipc/';

  // Normalize and prevent path traversal
  const normalized = path.normalize(containerPath);
  if (normalized.includes('..')) return null;

  if (normalized.startsWith(groupPrefix)) {
    const relative = normalized.slice(groupPrefix.length);
    return path.join(GROUPS_DIR, groupFolder, relative);
  }
  if (normalized.startsWith(ipcPrefix)) {
    const relative = normalized.slice(ipcPrefix.length);
    return path.join(DATA_DIR, 'ipc', groupFolder, relative);
  }

  return null;
}
```

Also add the missing import at the top of `ipc.ts`:

```typescript
import { DATA_DIR, GROUPS_DIR, IPC_POLL_INTERVAL, TIMEZONE, FILE_SEND_ALLOWLIST } from './config.js';
```

(Replace the existing config import line.)

- [ ] **Step 3: Add files/ directory processing to processIpcFiles**

In `src/ipc.ts`, inside the `for (const sourceGroup of groupFolders)` loop (after the tasks processing block, around line 146), add:

```typescript
      // Process file-send requests from this group's IPC directory
      const filesDir = path.join(ipcBaseDir, sourceGroup, 'files');
      try {
        if (fs.existsSync(filesDir)) {
          const fileManifests = fs
            .readdirSync(filesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of fileManifests) {
            const filePath = path.join(filesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (
                data.type === 'send_files' &&
                data.chatJid &&
                Array.isArray(data.files) &&
                data.files.length > 0
              ) {
                // Authorization: same as messages
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  !isMain &&
                  (!targetGroup || targetGroup.folder !== sourceGroup)
                ) {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized file send attempt blocked',
                  );
                  fs.unlinkSync(filePath);
                  continue;
                }

                // Resolve and validate each file
                const resolvedFiles: Array<{ path: string; name: string }> = [];
                let valid = true;
                for (const f of data.files) {
                  const hostPath = resolveContainerPath(f.path, sourceGroup);
                  if (!hostPath) {
                    logger.warn(
                      { containerPath: f.path, sourceGroup },
                      'File send rejected: path outside allowed mounts',
                    );
                    valid = false;
                    break;
                  }
                  const ext = path.extname(f.name || f.path).toLowerCase();
                  if (!FILE_SEND_ALLOWLIST.includes(ext)) {
                    logger.warn(
                      { ext, sourceGroup },
                      'File send rejected: extension not in allowlist',
                    );
                    valid = false;
                    break;
                  }
                  if (!fs.existsSync(hostPath)) {
                    logger.warn(
                      { hostPath, sourceGroup },
                      'File send rejected: file not found',
                    );
                    valid = false;
                    break;
                  }
                  const stat = fs.statSync(hostPath);
                  if (stat.size > 25 * 1024 * 1024) {
                    logger.warn(
                      { hostPath, size: stat.size, sourceGroup },
                      'File send rejected: exceeds 25MB limit',
                    );
                    valid = false;
                    break;
                  }
                  resolvedFiles.push({ path: hostPath, name: f.name || path.basename(f.path) });
                }

                if (valid && resolvedFiles.length > 0) {
                  await deps.sendFile(data.chatJid, resolvedFiles, data.caption);
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      sourceGroup,
                      fileCount: resolvedFiles.length,
                    },
                    'IPC files sent',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC file send',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC files directory',
        );
      }
```

- [ ] **Step 4: Add 'files' to IPC subdirectory setup in container-runner.ts**

In `src/container-runner.ts`, update the IPC subdirectory loop:

```typescript
  for (const sub of ['messages', 'tasks', 'input', 'files']) {
```

- [ ] **Step 5: Wire sendFile into IPC deps in index.ts**

In `src/index.ts`, add `sendFile` to the `startIpcWatcher` call (around line 632):

```typescript
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendFile: (jid, files, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendFile) throw new Error(`Channel ${channel.name} does not support file sending`);
      return channel.sendFile(jid, files, caption);
    },
    registeredGroups: () => registeredGroups,
    // ... rest unchanged
```

- [ ] **Step 6: Build to verify**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 7: Commit**

```bash
git add src/ipc.ts src/container-runner.ts src/index.ts
git commit -m "feat: add generic file-sending IPC with allowlist validation"
```

---

## Task 3: Discord sendFile Implementation

Implement the `sendFile()` method on DiscordChannel.

**Files:**
- Modify: `src/channels/discord.ts` (add sendFile method, add FileAttachment import)

- [ ] **Step 1: Add FileAttachment import**

In `src/channels/discord.ts`, update the types import:

```typescript
import {
  Channel,
  FileAttachment,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
```

- [ ] **Step 2: Add sendFile method to DiscordChannel**

Add after the existing `sendMessage` method (before `disconnect()`):

```typescript
  async sendFile(
    jid: string,
    files: FileAttachment[],
    caption?: string,
  ): Promise<void> {
    if (!this.client) throw new Error('Discord client not connected');

    const channelId = jid.replace(/^dc:/, '');
    const channel = await this.client.channels.fetch(channelId);

    if (!channel || !('send' in channel)) {
      logger.warn({ jid }, 'Discord channel not found or not text-based');
      return;
    }

    const textChannel = channel as TextChannel;

    // Send to active thread if one exists, otherwise to channel
    const threadId = this.getThread(jid);
    let target: TextChannel | Awaited<ReturnType<typeof textChannel.threads.fetch>> = textChannel;
    if (threadId) {
      try {
        const thread = await textChannel.threads.fetch(threadId);
        if (thread) target = thread;
      } catch {
        // Thread deleted, fall through to channel
      }
    }

    await (target as TextChannel).send({
      content: caption || undefined,
      files: files.map((f) => ({ attachment: f.path, name: f.name })),
    });

    logger.info(
      { jid, fileCount: files.length },
      'Discord files sent',
    );
  }
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add src/channels/discord.ts
git commit -m "feat: implement sendFile on Discord channel for file attachments"
```

---

## Task 4: MCP send_files Tool in Container

Add the `send_files` MCP tool so agents can trigger file sends.

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts:14-16` (add FILES_DIR constant), append new tool

- [ ] **Step 1: Add FILES_DIR constant**

In `container/agent-runner/src/ipc-mcp-stdio.ts`, after the existing dir constants (line 16):

```typescript
const FILES_DIR = path.join(IPC_DIR, 'files');
```

- [ ] **Step 2: Add send_files tool**

Add before the `// Start the stdio transport` line (line 336):

```typescript
server.tool(
  'send_files',
  `Send files (images, archives) to the chat as attachments. Files must exist on disk before calling this tool. Allowed extensions: .png, .zip (configurable by host).

Use this after generating output files (renders, archives, exports) to share them with the user.`,
  {
    files: z
      .array(
        z.object({
          path: z.string().describe('Absolute path to the file in the container (e.g., /workspace/group/render.png)'),
          name: z.string().describe('Filename shown to the recipient (e.g., model.png)'),
        }),
      )
      .min(1)
      .describe('Files to send'),
    caption: z
      .string()
      .optional()
      .describe('Optional text message sent alongside the files'),
  },
  async (args) => {
    // Validate files exist before writing IPC
    const missing = args.files.filter((f) => !fs.existsSync(f.path));
    if (missing.length > 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Files not found: ${missing.map((f) => f.path).join(', ')}`,
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'send_files',
      chatJid,
      files: args.files,
      caption: args.caption,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(FILES_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `${args.files.length} file(s) queued for sending.`,
        },
      ],
    };
  },
);
```

- [ ] **Step 3: Build agent-runner to verify**

Run from project root:
```bash
cd container/agent-runner && npm run build && cd ../..
```
Expected: Clean compile.

- [ ] **Step 4: Commit**

```bash
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: add send_files MCP tool for container agents"
```

---

## Task 5: OpenSCAD in Dockerfile

Install OpenSCAD, xvfb, zip, and create the `scad-render` wrapper script.

**Files:**
- Modify: `container/Dockerfile`
- Create: `container/scad-render.sh`

- [ ] **Step 1: Create scad-render wrapper script**

Create `container/scad-render.sh`:

```bash
#!/bin/bash
# Render an OpenSCAD file to PNG.
# Usage: scad-render <input.scad> [output.png] [WIDTHxHEIGHT]
# Extension point: swap this script for an STL→raytracer pipeline later.
set -euo pipefail

INPUT="$1"
OUTPUT="${2:-${INPUT%.scad}.png}"
SIZE="${3:-1024,1024}"

if [ ! -f "$INPUT" ]; then
  echo "Error: $INPUT not found" >&2
  exit 1
fi

# xvfb-run provides a virtual X display for OpenSCAD's renderer
xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24" \
  openscad -o "$OUTPUT" --imgsize="$SIZE" --render "$INPUT" 2>&1

if [ -f "$OUTPUT" ]; then
  echo "Rendered: $OUTPUT"
else
  echo "Error: rendering failed" >&2
  exit 1
fi
```

- [ ] **Step 2: Update Dockerfile**

In `container/Dockerfile`, after the existing `apt-get install` block (line 27), add a second install block:

```dockerfile
# Install OpenSCAD for 3D modeling and xvfb for headless rendering
RUN apt-get update && apt-get install -y \
    openscad \
    xvfb \
    zip \
    && rm -rf /var/lib/apt/lists/*
```

After the entrypoint script creation (after line 58), add the render wrapper:

```dockerfile
# Install scad-render wrapper for headless OpenSCAD rendering
COPY scad-render.sh /usr/local/bin/scad-render
RUN chmod +x /usr/local/bin/scad-render
```

- [ ] **Step 3: Add /workspace/ipc/files to directory creation**

Update line 52 in `container/Dockerfile`:

```dockerfile
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input /workspace/ipc/files
```

- [ ] **Step 4: Rebuild container image**

Run: `./container/build.sh`
Expected: Image builds successfully. Verify OpenSCAD is installed:
```bash
docker run --rm --entrypoint bash nanoclaw-agent:latest -c "openscad --version && scad-render --help 2>&1 || true"
```

- [ ] **Step 5: Commit**

```bash
git add container/Dockerfile container/scad-render.sh
git commit -m "feat: add OpenSCAD, xvfb, and scad-render to container image"
```

---

## Task 6: OpenSCAD Container Skill

Create the SKILL.md that teaches agents how to use OpenSCAD.

**Files:**
- Create: `container/skills/openscad/SKILL.md`

- [ ] **Step 1: Create the skill file**

Create `container/skills/openscad/SKILL.md`:

````markdown
---
name: openscad
description: Create 3D models with OpenSCAD — write .scad files, render to PNG preview, and send results back to chat. Use when asked to model, design, create, or visualize 3D objects, parts, or shapes.
---

# 3D Modeling with OpenSCAD

## Workflow

1. Write `.scad` file(s) in the current directory
2. Render preview: `scad-render model.scad render.png`
3. Package source: `zip model.zip *.scad`
4. Send to chat: use the `send_files` MCP tool

## Quick Example

```bash
# Write the model
cat > coke_can.scad << 'SCAD'
$fn = 64;

module coke_can() {
    // Body
    color("red")
    cylinder(h = 122, r = 33, center = false);

    // Top rim
    translate([0, 0, 122])
    color("silver")
    cylinder(h = 2, r = 33, center = false);

    // Bottom
    color("silver")
    cylinder(h = 2, r = 33, center = false);
}

coke_can();
SCAD

# Render to PNG
scad-render coke_can.scad render.png

# Package and send
zip model.zip *.scad
```

Then call the `send_files` MCP tool with the render.png and model.zip.

## OpenSCAD Language Reference

### Primitives

```scad
cube([width, depth, height]);
cube([10, 20, 30], center = true);

sphere(r = 10);
sphere(d = 20);  // diameter

cylinder(h = 20, r = 5);
cylinder(h = 20, r1 = 10, r2 = 5);  // cone
cylinder(h = 20, d = 10);

// Always set $fn for smooth curves
$fn = 64;  // 64 segments for circles
```

### Transformations

```scad
translate([x, y, z]) object();
rotate([x_deg, y_deg, z_deg]) object();
scale([x, y, z]) object();
mirror([1, 0, 0]) object();  // mirror along X
```

### Boolean Operations

```scad
union() { a(); b(); }         // combine
difference() { a(); b(); }    // subtract b from a
intersection() { a(); b(); }  // keep overlap only
```

### 2D to 3D

```scad
linear_extrude(height = 10) circle(r = 5);
rotate_extrude() translate([10, 0]) circle(r = 3);  // donut
```

### 2D Shapes

```scad
circle(r = 5);
square([10, 20], center = true);
polygon(points = [[0,0], [10,0], [5,10]]);
text("Hello", size = 10, font = "Liberation Sans");
```

### Modules and Variables

```scad
module bolt(length, diameter) {
    cylinder(h = length, d = diameter);
    translate([0, 0, length])
        cylinder(h = diameter * 0.6, d = diameter * 1.5);
}

bolt(20, 5);
bolt(length = 30, diameter = 8);
```

### Loops

```scad
for (i = [0:5]) translate([i * 10, 0, 0]) cube(5);
for (angle = [0:45:315]) rotate([0, 0, angle]) translate([20, 0, 0]) sphere(3);
```

### Color

```scad
color("red") cube(10);
color([0.2, 0.5, 0.8]) sphere(5);     // RGB 0-1
color([1, 0, 0, 0.5]) cube(10);        // RGBA with alpha
```

### Hull and Minkowski

```scad
hull() {                    // convex hull around children
    sphere(5);
    translate([20, 0, 0]) sphere(5);
}

minkowski() {               // rounded edges
    cube([10, 10, 5]);
    sphere(2);
}
```

### Import

```scad
import("part.stl");         // import STL
import("outline.svg");      // import SVG (2D)
```

## Rendering Tips

- Always set `$fn = 64` or higher for smooth curves
- Use `center = true` on primitives for easier positioning
- Keep models oriented with Z-up (OpenSCAD convention)
- For the preview render, default 1024x1024 is good. Use `scad-render model.scad render.png 2048,2048` for higher resolution
- Complex models with many booleans may take longer to render — keep it simple when possible

## Common Patterns

### Rounded Box

```scad
module rounded_box(size, radius) {
    minkowski() {
        cube([size.x - 2*radius, size.y - 2*radius, size.z - 2*radius], center = true);
        sphere(r = radius);
    }
}
```

### Threaded Rod (simplified)

```scad
module thread(length, diameter, pitch) {
    linear_extrude(height = length, twist = 360 * length / pitch)
        translate([diameter/2 - 0.5, 0]) circle(r = 0.5, $fn = 16);
}
```

### Hollow Cylinder (tube)

```scad
module tube(height, outer_r, wall) {
    difference() {
        cylinder(h = height, r = outer_r);
        translate([0, 0, -0.1])
            cylinder(h = height + 0.2, r = outer_r - wall);
    }
}
```
````

- [ ] **Step 2: Verify skill gets synced to container sessions**

The skill sync logic in `container-runner.ts` (lines 149-158) already copies from `container/skills/` to per-group `.claude/skills/`. Verify the directory name matches:

```bash
ls container/skills/openscad/SKILL.md
```

- [ ] **Step 3: Commit**

```bash
git add container/skills/openscad/SKILL.md
git commit -m "feat: add OpenSCAD container skill with language reference"
```

---

## Task 7: Add-OpenSCAD Setup Skill

Create the user-facing `/add-openscad` skill.

**Files:**
- Create: `.claude/skills/add-openscad/SKILL.md`

- [ ] **Step 1: Create the add-openscad skill**

Create `.claude/skills/add-openscad/SKILL.md`:

````markdown
---
name: add-openscad
description: Add OpenSCAD 3D modeling to NanoClaw. Agents can create .scad models, render them as PNG previews, and send both the rendered image and source files back to chat.
---

# Add OpenSCAD 3D Modeling

This skill adds OpenSCAD support to NanoClaw containers. After setup, agents can:
- Write `.scad` 3D model files
- Render them to PNG previews using `scad-render`
- Send the rendered image and zipped source files back to the chat

## Prerequisites

- NanoClaw must be set up and running
- At least one channel configured (Discord recommended for file attachments)
- Docker installed and working

## Setup Steps

### 1. Rebuild the container image

The Dockerfile already includes OpenSCAD, xvfb, and the `scad-render` wrapper. Rebuild:

```bash
./container/build.sh
```

Verify OpenSCAD is installed:

```bash
docker run --rm --entrypoint bash nanoclaw-agent:latest -c "openscad --version"
```

### 2. Verify the skill is deployed

The OpenSCAD skill (`container/skills/openscad/SKILL.md`) is automatically synced to container sessions on next container launch. Verify it exists:

```bash
ls container/skills/openscad/SKILL.md
```

### 3. Restart NanoClaw

```bash
# Linux (systemd)
systemctl restart nanoclaw   # or: systemctl --user restart nanoclaw

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 4. Test it

Send a message to the bot in Discord:

```
@NanoClaw create a 3D model of a coffee mug
```

The bot should:
1. Write a `.scad` file
2. Render it to PNG
3. Send both the PNG preview and a ZIP of the `.scad` files to the chat

## Troubleshooting

### "scad-render: command not found"
Container image needs rebuilding: `./container/build.sh`

### Rendering fails with display errors
The `scad-render` wrapper uses `xvfb-run` for headless rendering. If it fails, check that xvfb is installed in the container:
```bash
docker run --rm --entrypoint bash nanoclaw-agent:latest -c "which xvfb-run"
```

### Files not appearing in Discord
- Check that the Discord channel has `sendFile` support (it does by default after this update)
- Check `logs/nanoclaw.log` for "File send rejected" warnings — this means the file extension isn't in the allowlist
- Current allowlist: `.png`, `.zip`. Extend via `FILE_SEND_ALLOWLIST` env var in `.env`

### Agent doesn't use OpenSCAD
The agent needs the skill loaded. Verify it exists in the container:
```bash
docker run --rm --entrypoint bash nanoclaw-agent:latest -c "cat /home/node/.claude/skills/openscad/SKILL.md" 2>/dev/null
```
If missing, the skill sync happens at container launch. Try restarting NanoClaw and sending a new message.
````

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/add-openscad/SKILL.md
git commit -m "feat: add /add-openscad setup skill"
```

---

## Task 8: Build, Rebuild Container, Restart, and Manual Test

End-to-end verification.

- [ ] **Step 1: Build host code**

```bash
npm run build
```

- [ ] **Step 2: Rebuild container image**

```bash
./container/build.sh
```

- [ ] **Step 3: Verify OpenSCAD works in container**

```bash
docker run --rm --entrypoint bash nanoclaw-agent:latest -c "
  echo 'cube(10);' > /tmp/test.scad && \
  scad-render /tmp/test.scad /tmp/test.png && \
  ls -la /tmp/test.png
"
```
Expected: `test.png` exists with non-zero size.

- [ ] **Step 4: Restart NanoClaw**

```bash
systemctl restart nanoclaw
```

- [ ] **Step 5: Manual test in Discord**

Send `@NanoClaw create a 3D model of a coke can` in Discord. Verify:
1. Agent writes `.scad` file
2. Agent renders PNG
3. Agent sends PNG + ZIP as Discord attachments
4. Files appear in the thread

- [ ] **Step 6: Final commit if any fixes needed**
