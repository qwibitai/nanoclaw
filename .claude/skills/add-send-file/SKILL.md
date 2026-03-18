---
name: add-send-file
description: Add WhatsApp file sending support — lets the agent send documents, PDFs, images, spreadsheets, and any file to the user via the mcp__nanoclaw__send_file MCP tool.
---

# Add Send File

This skill adds the ability for the container agent to send files (documents, PDFs, spreadsheets, images, etc.) back to the user via WhatsApp. After creating a file with Python scripts or other tools, the agent calls `mcp__nanoclaw__send_file` with the file path and the file is delivered to the chat.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `send-file` is in `applied_skills`, skip to Phase 3 (Verify).

## Phase 2: Apply Code Changes

### Modify src/types.ts

Add `sendDocument?` to the `Channel` interface after `reactToLatestMessage?`:

```typescript
// Optional: file/document sending
sendDocument?(
  jid: string,
  filePath: string,
  fileName: string,
  mimeType: string,
): Promise<void>;
```

### Modify src/channels/whatsapp.ts

Add the `sendDocument` method to `WhatsAppChannel` before `setTyping`:

```typescript
async sendDocument(
  jid: string,
  filePath: string,
  fileName: string,
  mimeType: string,
): Promise<void> {
  if (!this.connected) {
    throw new Error('Not connected to WhatsApp');
  }
  const buffer = fs.readFileSync(filePath);
  await this.sock.sendMessage(jid, {
    document: buffer,
    fileName,
    mimetype: mimeType,
  });
  logger.info({ jid, fileName, size: buffer.length }, 'Document sent');
}
```

### Modify src/ipc.ts

Add `sendDocument?` to the `IpcDeps` interface after `sendReaction?`:

```typescript
sendDocument?: (
  jid: string,
  filePath: string,
  fileName: string,
  mimeType: string,
) => Promise<void>;
```

In the IPC message processing loop, add a handler for `type: 'send_file'` before the `type: 'reaction'` handler:

```typescript
} else if (
  data.type === 'send_file' &&
  data.chatJid &&
  data.filePath &&
  data.fileName &&
  data.mimeType &&
  deps.sendDocument
) {
  const targetGroup = registeredGroups[data.chatJid];
  if (
    isMain ||
    (targetGroup && targetGroup.folder === sourceGroup)
  ) {
    try {
      await deps.sendDocument(
        data.chatJid,
        data.filePath,
        data.fileName,
        data.mimeType,
      );
      logger.info(
        { chatJid: data.chatJid, fileName: data.fileName, sourceGroup },
        'IPC document sent',
      );
    } catch (err) {
      logger.error(
        { chatJid: data.chatJid, fileName: data.fileName, sourceGroup, err },
        'IPC document send failed',
      );
    }
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC send_file attempt blocked',
    );
  }
}
```

### Modify src/index.ts

In the `startIpcWatcher()` call, add `sendDocument` before `sendReaction`:

```typescript
sendDocument: async (jid, filePath, fileName, mimeType) => {
  const channel = findChannel(channels, jid);
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  if (!channel.sendDocument)
    throw new Error('Channel does not support sendDocument');
  await channel.sendDocument(jid, filePath, fileName, mimeType);
},
```

### Modify container/agent-runner/src/ipc-mcp-stdio.ts

Add the `send_file` MCP tool before the `react_to_message` tool:

```typescript
server.tool(
  'send_file',
  'Send a file (document, PDF, image, spreadsheet, etc.) to the user or group via WhatsApp. The file must exist on the container filesystem under /workspace/group/. Use this after creating a file with Python scripts or other tools.',
  {
    file_path: z.string().describe('Absolute path to the file on the container filesystem (e.g. /workspace/group/report.xlsx)'),
    file_name: z.string().optional().describe('Display name for the file as shown to the recipient. Defaults to the basename of file_path.'),
    mime_type: z.string().optional().describe('MIME type of the file. Auto-detected from extension if omitted.'),
  },
  async (args) => {
    if (!fs.existsSync(args.file_path)) {
      return {
        content: [{ type: 'text' as const, text: `File not found: ${args.file_path}` }],
        isError: true,
      };
    }

    const fileName = args.file_name || path.basename(args.file_path);

    let mimeType = args.mime_type;
    if (!mimeType) {
      const ext = args.file_path.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
      const mimeMap: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.xls': 'application/vnd.ms-excel',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.doc': 'application/msword',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.ppt': 'application/vnd.ms-powerpoint',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.mp3': 'audio/mpeg',
        '.ogg': 'audio/ogg',
        '.txt': 'text/plain',
        '.csv': 'text/csv',
        '.json': 'application/json',
        '.zip': 'application/zip',
        '.svg': 'image/svg+xml',
      };
      mimeType = mimeMap[ext] || 'application/octet-stream';
    }

    const data = {
      type: 'send_file',
      chatJid,
      filePath: args.file_path,
      fileName,
      mimeType,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `File "${fileName}" queued for sending.` }],
    };
  },
);
```

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Rebuild Container and Restart

The agent-runner inside the container must be rebuilt for the new MCP tool to be available:

```bash
./container/build.sh
```

Then restart the service:

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

### Test via WhatsApp

Ask the agent to create a file and send it:

> "Erstell eine einfache Textdatei mit dem Inhalt 'Hello World' und schick sie mir."

The agent should:
1. Write the file to `/workspace/group/`
2. Call `mcp__nanoclaw__send_file` with the path
3. The file should appear in your WhatsApp chat as a document

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i "document sent\|send_file\|IPC document"
```

Look for:
- `Document sent` — file successfully sent via Baileys
- `IPC document sent` — IPC handler processed the send_file message
- `IPC document send failed` — something went wrong (check err field)

## Notes

- Files are read from the container filesystem at send time (when IPC is processed by the host)
- The container mounts `/workspace/group/` → `data/groups/<folder>/` on the host, so files written there persist and are accessible to the host process
- MIME type is auto-detected from the file extension; pass `mime_type` explicitly to override
- WhatsApp supports most document types; very large files (>64 MB) may be rejected by WhatsApp servers

## Troubleshooting

### "File not found" error from the MCP tool

The file path must be on the container filesystem at call time. Make sure the file was written to `/workspace/group/` (not `/tmp/` — that's ephemeral and not mounted from host).

Container paths: `/workspace/group/` maps to `data/groups/<folder>/` on the host.

### File arrives as corrupted/empty

Verify the file was created correctly:
```bash
ls -la data/groups/<folder>/<filename>
file data/groups/<folder>/<filename>
```

### "Channel does not support sendDocument"

Only WhatsApp supports `sendDocument`. If using a different channel (Telegram, Discord, Slack), file sending is not yet implemented for that channel.
