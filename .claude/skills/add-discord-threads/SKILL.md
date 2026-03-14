---
name: add-discord-threads
description: Add Discord thread management to NanoClaw. Agents can create and manage threads, and replies auto-route to active threads. Requires Discord channel to be set up first (use /add-discord).
---

# Add Discord Thread Management

This skill adds Discord thread support: agents can create/manage threads via MCP tools, and incoming thread messages are automatically routed so replies go to the correct thread.

> **Compatibility:** NanoClaw v1.0.0. Requires Discord channel already set up (`/add-discord`).

## Features

| Tool | Description |
|------|-------------|
| `discord_create_thread` | Create a new thread in the current Discord channel |
| `discord_manage_thread` | Archive, unarchive, lock, unlock, or rename a thread |

## File Structure

```
.claude/skills/add-discord-threads/
├── SKILL.md            # This documentation
├── container-skill.md  # Agent-readable skill doc (copied to container)
├── mcp-tools.ts        # Container-side MCP tool registrations
└── ipc-handlers.ts     # Host-side IPC handler functions
```

## Prerequisites

1. Discord channel exists:
   ```bash
   test -f src/channels/discord.ts || echo "MISSING: Run /add-discord first"
   ```

2. Two-layer mount mechanism in place (required for MCP tool discovery):
   ```bash
   grep -q 'src-global' src/container-runner.ts || echo "MISSING: Update container-runner.ts to two-layer mount"
   ```

## Integration Points

### 1. Container skill documentation

Copy the fixed skill doc to the container skills directory:

```bash
mkdir -p container/skills/discord-threads
cp .claude/skills/add-discord-threads/container-skill.md container/skills/discord-threads/SKILL.md
```

---

### 2. Container MCP tools: `container/agent-runner/src/ipc-mcp-stdio.ts`

Append the contents of `.claude/skills/add-discord-threads/mcp-tools.ts` to `container/agent-runner/src/ipc-mcp-stdio.ts`, **before** the `// Start the stdio transport` line.

The file contains:
- `THREAD_RESULTS_DIR` constant
- `waitForThreadResult()` helper (polls for IPC result files)
- `discord_create_thread` tool registration
- `discord_manage_thread` tool registration

---

### 3. Host IPC handlers: `src/ipc.ts`

**3a.** In the `processTaskIpc` function's `switch` statement, add two new cases **before** the `default` case:

```typescript
    case 'discord_create_thread':
      await handleDiscordCreateThread(data, sourceGroup);
      break;

    case 'discord_manage_thread':
      await handleDiscordManageThread(data, sourceGroup);
      break;
```

**3b.** Append the contents of `.claude/skills/add-discord-threads/ipc-handlers.ts` to the bottom of `src/ipc.ts`.

The file contains `handleDiscordCreateThread()` and `handleDiscordManageThread()` functions that use discord.js REST API directly (no Client instance needed).

---

### 4. Passive thread awareness: `src/channels/discord.ts`

These are small inline modifications to the existing Discord channel code.

**4a.** Add `ThreadChannel` to the import from `discord.js`:

```typescript
import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
  ThreadChannel,
} from 'discord.js';
```

**4b.** Add an `activeThreads` map to the `DiscordChannel` class properties (after `private botToken`):

```typescript
  private activeThreads = new Map<string, string>();
```

**4c.** In the `MessageCreate` handler, **replace** the existing `const channelId` and `const chatJid` lines after `if (message.author.bot) return;` with:

```typescript
      let channelId = message.channelId;
      let chatJid = `dc:${channelId}`;

      // Thread awareness: if message is in a thread, resolve to parent channel
      const isThread = message.channel instanceof ThreadChannel;
      if (isThread) {
        const threadChannel = message.channel as ThreadChannel;
        const parentId = threadChannel.parentId;
        if (parentId) {
          const parentJid = `dc:${parentId}`;
          this.activeThreads.set(parentJid, channelId);
          channelId = parentId;
          chatJid = parentJid;
        }
      }
```

**4d.** In `sendMessage`, **replace** `const channelId = jid.replace(/^dc:/, '');` with:

```typescript
      const activeThreadId = this.activeThreads.get(jid);
      const channelId = activeThreadId || jid.replace(/^dc:/, '');
```

**4e.** In `setTyping`, **replace** `const channelId = jid.replace(/^dc:/, '');` with:

```typescript
      const activeThreadId = this.activeThreads.get(jid);
      const channelId = activeThreadId || jid.replace(/^dc:/, '');
```

---

### 5. Update test mock: `src/channels/discord.test.ts`

Add `ThreadChannel` class to the discord.js mock return value:

```typescript
  class ThreadChannel {}

  return {
    Client: MockClient,
    Events,
    GatewayIntentBits,
    TextChannel,
    ThreadChannel,
  };
```

## Validate

```bash
npm run build
npm test
```

Both must pass with zero failures.

## Deploy

```bash
# Rebuild container (picks up new container skill doc)
./container/build.sh

# Restart service
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Notes

- Bot needs `MANAGE_THREADS` + `CREATE_PUBLIC_THREADS` Discord server permissions
- discord.js is already a project dependency; REST class is used directly (no extra Client instance)
- `DISCORD_BOT_TOKEN` is read from env / `.env`
- Thread tools only work for Discord channels (chatJid starting with `dc:`)
- Active thread tracking is per-parent-channel; when a user messages in a thread, subsequent agent replies route there automatically
