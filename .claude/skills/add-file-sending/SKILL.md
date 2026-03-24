---
name: add-file-sending
description: Add file sending capability to NanoClaw. Agents can send PDFs, images, documents, and other files to WhatsApp using the mcp__nanoclaw__send_file tool.
---

# Add File Sending

This skill adds a `send_file` MCP tool that lets agents send files from their workspace to the user over WhatsApp. Supported types: PDF, images (PNG/JPG/GIF/WebP), video (MP4/MOV), audio (MP3/WAV/OGG), Office docs, plain text, CSV, ZIP.

## Step 1: Add `send_file` tool to the MCP server

**File:** `container/agent-runner/src/ipc-mcp-stdio.ts`

Add the following tool after the `send_message` tool (before `schedule_task`):

```typescript
server.tool(
  'send_file',
  "Send a file (PDF, image, document, video, etc.) to the user or group immediately. The file must exist at the given absolute path under /workspace/group/.",
  {
    file_path: z.string().describe('Absolute path to the file (e.g., "/workspace/group/report.pdf"). Must be under /workspace/group/.'),
    caption: z.string().optional().describe('Optional caption to accompany the file'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    if (!path.isAbsolute(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File path must be absolute. Got: "${args.file_path}"` }],
        isError: true,
      };
    }

    const CONTAINER_GROUP_PREFIX = '/workspace/group/';
    if (!args.file_path.startsWith(CONTAINER_GROUP_PREFIX)) {
      return {
        content: [{ type: 'text' as const, text: `File must be under /workspace/group/. Got: "${args.file_path}"` }],
        isError: true,
      };
    }

    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: "${args.file_path}"` }],
        isError: true,
      };
    }

    try {
      fs.accessSync(args.file_path, fs.constants.R_OK);
    } catch {
      return {
        content: [{ type: 'text' as const, text: `File is not readable: "${args.file_path}"` }],
        isError: true,
      };
    }

    const data: Record<string, string | undefined> = {
      type: 'file',
      chatJid,
      file_path: args.file_path,
      caption: args.caption || undefined,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'File queued for sending.' }] };
  },
);
```

## Step 2: Add `sendFile?` to the Channel interface

**File:** `src/types.ts`

In the `Channel` interface, add the optional method after `setTyping?`:

```typescript
  // Optional: send a file. Channels that support file delivery implement it.
  sendFile?(jid: string, filePath: string, caption?: string): Promise<void>;
```

## Step 3: Handle `type: 'file'` in the IPC watcher

**File:** `src/ipc.ts`

### 3a. Add `sendFile` to the import from `group-folder.js`

Find:
```typescript
import { isValidGroupFolder } from './group-folder.js';
```
Change to:
```typescript
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
```

### 3b. Add `sendFile` to `IpcDeps`

In the `IpcDeps` interface, add after `sendMessage`:
```typescript
  sendFile: (jid: string, filePath: string, caption?: string) => Promise<void>;
```

### 3c. Handle `type: 'file'` in the message processing loop

In `startIpcWatcher`, inside the loop that processes IPC message files, find the block that handles `data.type === 'message'` and add an `else if` branch immediately after it (before `fs.unlinkSync`):

```typescript
} else if (data.type === 'file' && data.chatJid && data.file_path) {
  // Authorization: verify this group can send to this chatJid
  const targetGroup = registeredGroups[data.chatJid];
  if (
    isMain ||
    (targetGroup && targetGroup.folder === sourceGroup)
  ) {
    // Translate container-internal path to host path.
    // Agents write files to /workspace/group/ which maps to
    // groups/{sourceGroup}/ on the host.
    const CONTAINER_GROUP_PREFIX = '/workspace/group/';
    const containerPath: string = data.file_path;
    if (!containerPath.startsWith(CONTAINER_GROUP_PREFIX)) {
      logger.warn(
        { chatJid: data.chatJid, containerPath, sourceGroup },
        'IPC file path not under /workspace/group/, blocked',
      );
    } else {
      const relativePath = containerPath.slice(CONTAINER_GROUP_PREFIX.length);
      const groupDir = resolveGroupFolderPath(sourceGroup);
      const hostFilePath = path.resolve(groupDir, relativePath);
      // Prevent path traversal
      const rel = path.relative(groupDir, hostFilePath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        logger.warn(
          { chatJid: data.chatJid, containerPath, hostFilePath, sourceGroup },
          'IPC file path traversal blocked',
        );
      } else {
        await deps.sendFile(data.chatJid, hostFilePath, data.caption);
        logger.info(
          { chatJid: data.chatJid, hostFilePath, sourceGroup },
          'IPC file sent',
        );
      }
    }
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC file send attempt blocked',
    );
  }
}
```

## Step 4: Wire `sendFile` in `src/index.ts`

In `startIpcWatcher({...})`, add `sendFile` after `sendMessage`:

```typescript
    sendFile: async (jid, filePath, caption) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (!channel.sendFile) {
        logger.warn({ jid, channel: channel.name }, 'Channel does not support file sending');
        return;
      }
      return channel.sendFile(jid, filePath, caption);
    },
```

Note: `findChannel` is already imported from `./router.js`. If the project uses a direct `whatsapp` reference instead of `channels`/`findChannel`, adapt accordingly to route through the WhatsApp instance.

## Step 5: Implement `sendFile` in the WhatsApp channel

**File:** `src/channels/whatsapp.ts`

### 5a. Add the MIME type map and helper before the class

Add after the `GROUP_SYNC_INTERVAL_MS` constant:

```typescript
const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}
```

### 5b. Add `sendFile` method to `WhatsAppChannel`

Add the method inside the class, before `isConnected()`:

```typescript
  async sendFile(jid: string, filePath: string, caption?: string): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid, filePath }, 'WhatsApp not connected, cannot send file');
      throw new Error('WhatsApp not connected');
    }

    const buffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const mimetype = getMimeType(filePath);

    // Prefix caption with assistant name on shared numbers (same logic as text messages)
    const prefixedCaption = caption
      ? ASSISTANT_HAS_OWN_NUMBER
        ? caption
        : `${ASSISTANT_NAME}: ${caption}`
      : undefined;

    try {
      if (mimetype.startsWith('image/')) {
        await this.sock.sendMessage(jid, { image: buffer, caption: prefixedCaption });
        logger.info({ jid, filePath, mimetype }, 'Image sent');
      } else if (mimetype.startsWith('video/')) {
        await this.sock.sendMessage(jid, { video: buffer, caption: prefixedCaption });
        logger.info({ jid, filePath, mimetype }, 'Video sent');
      } else if (mimetype.startsWith('audio/')) {
        await this.sock.sendMessage(jid, { audio: buffer, ptt: false });
        logger.info({ jid, filePath, mimetype }, 'Audio sent');
      } else {
        await this.sock.sendMessage(jid, {
          document: buffer,
          mimetype,
          fileName: filename,
          caption: prefixedCaption,
        });
        logger.info({ jid, filePath, mimetype }, 'Document sent');
      }
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send file');
      throw err;
    }
  }
```

Note: `fs` and `path` are already imported at the top of `whatsapp.ts`.

## Step 6: Update the test mock

**File:** `src/ipc-auth.test.ts`

In the `deps` object in `beforeEach`, add:
```typescript
    sendFile: async () => {},
```

## Step 7: Build and test

```bash
npm run build
npx vitest run
```

All tests must pass and the build must be clean.

## Step 8: Rebuild the agent container

```bash
./container/build.sh
```

The container entrypoint compiles `src/ipc-mcp-stdio.ts` at startup, so the new `send_file` tool is available immediately after rebuild.

## Verify it works

Ask the agent to send a file:

> Send me /workspace/group/any-file.pdf

The file should arrive in WhatsApp. Check logs for `IPC file sent`.

## How it works

1. Agent calls `mcp__nanoclaw__send_file({ file_path: "/workspace/group/report.pdf", caption: "Here's the report" })`
2. MCP server validates the path (absolute, under `/workspace/group/`, exists, readable) and writes `{ type: "file", ... }` to the IPC messages dir
3. Host IPC watcher picks it up, translates the container path to the host path (`/workspace/group/X` → `groups/{folder}/X`), and calls `channel.sendFile()`
4. WhatsApp channel reads the file into a buffer, detects the MIME type by extension, and calls the appropriate Baileys message type (image/video/audio/document)
5. File appears in WhatsApp

Path traversal is blocked — only files under the group's own workspace can be sent.
