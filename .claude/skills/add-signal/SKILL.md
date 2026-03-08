---
name: add-signal
description: Add Signal as a channel via signal-cli JSON-RPC daemon. Supports messages, reactions, typing indicators, and reply threading.
---

# Add Signal Channel

This skill adds Signal messaging support to NanoClaw using the signal-cli daemon in JSON-RPC mode over a Unix socket.

## Prerequisites

1. **signal-cli** installed and registered with a phone number
2. signal-cli running in JSON-RPC daemon mode:
   ```bash
   signal-cli -a +1234567890 daemon --socket /tmp/signal-cli.sock
   ```

## Apply

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-signal
npm run build
```

## Configuration

Add to `.env`:
```
SIGNAL_ACCOUNT_NUMBER=+1234567890
SIGNAL_SOCKET_PATH=/tmp/signal-cli.sock   # optional, this is the default
```

## How It Works

- Connects to signal-cli via Unix socket using JSON-RPC protocol
- Listens for `receive` and `sync` notifications for incoming messages
- JID format: `signal:+1234567890` (DM) or `signal:group:{groupId}` (group)
- Supports reactions via `sendReaction` RPC call
- Auto-reconnects with exponential backoff on disconnect
- Syncs group metadata on connect

## Register a Signal Group

From the main group, use the `register_group` tool:
```
JID: signal:group:{base64-group-id}
folder: signal_group-name
trigger: @Bot
```

## Attachments

Incoming attachments (images, documents, voice notes, videos) are automatically handled:

- **Metadata** is extracted and shown in message context:
  `[attachment: photo.jpg (image/jpeg, 357KB 1440x2560)]`

- **Files** are downloaded to the group's `attachments/` directory and the path
  is included in context:
  `[file: /workspace/group/attachments/12345678901234-photo.jpg]`

- The agent can use its Read tool to view images or PDFs directly.

- Attachment-only messages (no text/caption) are supported.

- Downloads are idempotent — re-processing won't re-fetch existing files.

Outbound attachments (sending files) are not yet supported.
