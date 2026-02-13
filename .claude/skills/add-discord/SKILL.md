---
name: add-discord
description: Add Discord as a messaging channel. Both WhatsApp and Discord implementations remain in the codebase — which channels are active at runtime is controlled by environment configuration.
---

# Add Discord Channel

This skill adds Discord as a messaging channel to a NanoClaw installation. Both WhatsApp and Discord implementations will exist in the codebase, but which channels are active at runtime is determined by environment configuration:

- `DISCORD_BOT_TOKEN` is set → Discord channel starts
- WhatsApp auth session exists → WhatsApp channel starts
- Both configured → both channels run in parallel
- Neither configured → error on startup

This means the operator chooses which channels to run by setting environment variables and configuring auth — no code changes needed. Forkers of this repo can use WhatsApp only, Discord only, or both without modifying source.

## Prerequisites

- A Discord Bot Token (from https://discord.com/developers/applications)
- The bot must have the following permissions/intents enabled:
  - **Privileged Gateway Intents:** Message Content Intent, Server Members Intent
  - **Bot Permissions:** Send Messages, Read Message History, Add Reactions, Use Slash Commands
  - The bot must be invited to the target Discord server with these permissions

## Questions to Ask

Before making changes, ask the user:

1. **Trigger pattern?** "Should Discord use the same trigger pattern (e.g., @Andy), or should the bot respond to Discord @mentions of the bot user automatically?"
   - Recommended default: Respond to Discord @mentions of the bot (most natural for Discord)
   - Alternative: Keep a text-based trigger word like the WhatsApp default

2. **Main channel?** "Which Discord channel should be the privileged main/admin channel? This is typically a private channel only you can see."
   - The main channel gets elevated privileges: registering groups, managing tasks across all groups, full project filesystem access
   - If the user also runs WhatsApp, they may have a separate WhatsApp main channel — either or both can serve as admin channels

3. **Channel registration?** "Do you want to pre-register specific Discord channels as groups now, or register them later via the main channel?"
   - If now: Ask for channel names and their intended purposes
   - If later: The user can register channels at runtime via the main channel

## Implementation Steps

### Step 1: Install Dependencies

```bash
npm install discord.js
```

Keep all existing WhatsApp/Baileys dependencies intact.

### Step 2: Create src/channels/discord.ts

Create a new file `src/channels/discord.ts` with the Discord connection logic. This file should handle:

- **Client initialization**: Create a discord.js `Client` with the `GatewayIntentBits.Guilds`, `GatewayIntentBits.GuildMessages`, and `GatewayIntentBits.MessageContent` intents
- **Message handling**: Listen for the `messageCreate` event. Ignore messages from the bot itself. Check for the trigger pattern (bot mention or text trigger). Extract: channel ID, message author ID, author display name, message content (strip the bot mention if used as trigger), timestamp, and whether the message is in a guild channel
- **Send message function**: Export an async function `sendDiscordMessage(channelId: string, text: string)` that sends a message to a Discord channel. Handle Discord's 2000-character message limit by splitting long responses into multiple messages. Preserve code blocks when splitting
- **Typing indicator**: Export an async function `setDiscordTyping(channelId: string)` that calls `channel.sendTyping()`. Note: Discord typing indicators last 10 seconds and must be refreshed for longer operations
- **Ready event**: Log when the bot connects and print the bot's username and the servers it's in
- **Error handling**: Handle disconnects and reconnection gracefully. discord.js handles reconnection automatically, but log events for debugging

Example structure:

```typescript
import { Client, GatewayIntentBits, Message, TextChannel, ChannelType } from 'discord.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Store the message handler callback - set by the orchestrator
let onMessageCallback: ((msg: {
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: number;
  isGuild: boolean;
}) => void) | null = null;

export function onMessage(callback: typeof onMessageCallback) {
  onMessageCallback = callback;
}

client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;

  // Check trigger: bot mention or text pattern
  const botMention = `<@${client.user?.id}>`;
  const isMentioned = message.content.includes(botMention);

  // Also check text trigger pattern from config
  const triggerMatch = message.content.match(TRIGGER_PATTERN);

  if (!isMentioned && !triggerMatch) return;

  // Strip the mention/trigger from content
  let content = message.content;
  if (isMentioned) {
    content = content.replace(botMention, '').trim();
  } else if (triggerMatch) {
    content = content.replace(triggerMatch[0], '').trim();
  }

  if (onMessageCallback) {
    onMessageCallback({
      channelId: message.channelId,
      authorId: message.author.id,
      authorName: message.member?.displayName || message.author.username,
      content,
      timestamp: message.createdTimestamp,
      isGuild: message.guild !== null,
    });
  }
});

export async function sendDiscordMessage(channelId: string, text: string) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) return;

  // Discord has a 2000 char limit per message
  const MAX_LENGTH = 2000;
  if (text.length <= MAX_LENGTH) {
    await (channel as TextChannel).send(text);
    return;
  }

  // Split long messages, trying to break at newlines
  let remaining = text;
  while (remaining.length > 0) {
    let chunk: string;
    if (remaining.length <= MAX_LENGTH) {
      chunk = remaining;
      remaining = '';
    } else {
      let splitIndex = remaining.lastIndexOf('\n', MAX_LENGTH);
      if (splitIndex === -1 || splitIndex < MAX_LENGTH / 2) {
        splitIndex = MAX_LENGTH;
      }
      chunk = remaining.substring(0, splitIndex);
      remaining = remaining.substring(splitIndex).trimStart();
    }
    await (channel as TextChannel).send(chunk);
  }
}

export async function setDiscordTyping(channelId: string) {
  const channel = await client.channels.fetch(channelId);
  if (channel && channel.type === ChannelType.GuildText) {
    await (channel as TextChannel).sendTyping();
  }
}

export async function startDiscord(token: string): Promise<void> {
  client.on('ready', () => {
    console.log(`Discord bot logged in as ${client.user?.tag}`);
    console.log(`Connected to ${client.guilds.cache.size} server(s)`);
  });

  await client.login(token);
}

export function getClient(): Client {
  return client;
}
```

### Step 3: Update src/index.ts

This is the main orchestrator. Modify it to conditionally initialize channels based on environment configuration.

1. Keep all existing WhatsApp code intact, but wrap WhatsApp initialization in a conditional check (e.g., `if (whatsappAuthExists())` or check for the WhatsApp auth state directory)
2. Import from `src/channels/discord.ts`
3. In the `main()` function, add conditional Discord initialization:
   ```typescript
   if (process.env.DISCORD_BOT_TOKEN) {
     await startDiscord(process.env.DISCORD_BOT_TOKEN);
     // Set up onMessage callback to persist incoming Discord messages to SQLite
   }
   ```
4. Log which channels are active on startup (e.g., `"Channels active: discord"` or `"Channels active: whatsapp, discord"`)
5. If neither channel is configured, log an error and exit
6. In the message handler, detect which platform a message came from by checking the `platform` field on the message record
7. Route outbound messages to the correct platform based on the group's registered platform:
   - WhatsApp groups: Use existing `sock.sendMessage()` and `sock.sendPresenceUpdate()`
   - Discord groups: Use `sendDiscordMessage(channelId, text)` and `setDiscordTyping(channelId)`
8. Update group identification: WhatsApp uses JIDs (e.g., `123456@g.us`), Discord uses channel IDs (snowflake strings like `"1234567890123456789"`) — both are stored as strings, so the existing schema should accommodate both with the addition of a `platform` discriminator

### Step 4: Update src/db.ts

Modify the database schema to accommodate Discord alongside WhatsApp:

1. The `chats` table: Add a `platform` column (`'whatsapp' | 'discord'`) to distinguish between channel types. The existing `jid` or identifier field can store Discord channel IDs as-is since both WhatsApp JIDs and Discord snowflake IDs are strings
2. The `messages` table: Add a `platform` column (`'whatsapp' | 'discord'`). The `sender` field should store Discord user IDs for Discord messages. Add or update fields as needed:
   - `sender_name` — Discord display name (already may exist)
   - `channel_id` — Can hold either WhatsApp JID or Discord channel snowflake ID
3. The `registered_groups` data: Each group entry should include a `platform` field so the orchestrator knows which channel to route outbound messages through

**Important:** Run any schema migrations carefully. Back up `data/messages.db` before modifying. Use `ALTER TABLE` for existing databases or drop/recreate for fresh installs.

### Step 5: Update src/router.ts

Modify outbound message formatting to support both platforms:

1. Add platform-aware formatting: WhatsApp and Discord both support Markdown-like syntax but with differences (e.g., WhatsApp uses `_italic_` while Discord uses `*italic*`). The router should check the group's platform and format accordingly
2. For Discord messages, if the agent response contains very long content, the router should split it respecting Discord's 2000-character limit (delegate to `sendDiscordMessage` which handles splitting)
3. Keep existing WhatsApp formatting logic intact for WhatsApp groups

### Step 6: Update src/config.ts

1. Update `TRIGGER_PATTERN`: If using bot mentions as the trigger, the pattern changes. If keeping a text trigger, update the default (e.g., from `@Andy` to whatever the user prefers)
2. Add Discord-specific config constants if needed (e.g., `DISCORD_BOT_TOKEN` sourced from environment)

### Step 7: Update IPC Handler

In `src/index.ts` (or `src/ipc.ts`), the IPC watcher processes `send_message` actions from the container agent. Update the handler:

1. Add platform-aware routing: Look up the group's registered platform and call either `sock.sendMessage(jid, { text })` for WhatsApp or `sendDiscordMessage(channelId, text)` for Discord
2. If the target platform's channel is not active (e.g., a group is registered as WhatsApp but only Discord is running), log a warning rather than crashing
3. Ensure the IPC message format carries the correct channel identifier for routing (WhatsApp JID or Discord channel ID)

In `container/agent-runner/ipc-mcp.ts`, the `send_message` tool writes JSON to the IPC directory. The schema should use `channelId` (or keep the existing field name if you're doing a simple rename). No changes needed inside the container if the field names are kept compatible.

### Step 8: Update Container and Environment

1. Add `DISCORD_BOT_TOKEN` to the environment. Store it in a `.env` file or export it in the shell. **Never commit the token to git.**
2. Update `.gitignore` to include `.env` if not already present
3. If the setup skill or systemd service template exists, update it to include the Discord token in the environment
4. Document the runtime toggle behavior in a `.env.example` file:
   ```bash
   # Channel Configuration (set the tokens/auth for the channels you want active)
   # Discord: Set this token to enable the Discord channel
   DISCORD_BOT_TOKEN=
   # WhatsApp: Enabled automatically when WhatsApp auth session exists in data/auth/
   # At least one channel must be configured or the service will not start.
   ```

### Step 9: Update Authentication

WhatsApp authentication (`src/auth.ts`) handles QR code pairing and session persistence. Discord authentication is simpler — it's just a bot token passed to `client.login()`.

- Keep all existing WhatsApp auth intact — it serves as the implicit toggle for WhatsApp (auth session present = WhatsApp starts)
- Add Discord token handling as a separate path — the bot token is read from the `DISCORD_BOT_TOKEN` environment variable (token present = Discord starts)
- No additional auth state directory is needed for Discord since the bot token is stateless
- The orchestrator should check both auth sources on startup and only initialize channels that are configured

### Step 10: Update package.json

1. Add `discord.js` to dependencies
2. Keep all existing WhatsApp dependencies (`@whiskeysockets/baileys`, `@hapi/boom`, etc.)
3. Verify the `build` and `dev` scripts still work after changes

### Step 11: Update Documentation

1. Update `README.md`:
   - Update the architecture line to reflect both possible channels: `WhatsApp (baileys) and/or Discord (discord.js) → SQLite → Polling Loop → Container (Claude Agent SDK) → Response`
   - Add Discord bot setup instructions alongside existing WhatsApp instructions
   - Add usage examples showing Discord @mentions or trigger patterns
   - Document the runtime channel toggle: which channels are active depends on environment configuration, not code changes
2. Update `CLAUDE.md` to document the multi-channel architecture and the `platform` field on groups
3. Note in documentation that each group is tied to a specific platform — a Discord channel group routes through Discord, a WhatsApp group routes through WhatsApp
4. Document the `.env.example` file and explain that operators enable channels by configuring their credentials (Discord bot token, WhatsApp auth session)

### Step 12: Service Management (Linux/systemd)

If the user is deploying on Linux with systemd (not macOS launchd):

1. Create a systemd service file at `/etc/systemd/system/nanoclaw.service` (or user-level equivalent):

```ini
[Unit]
Description=NanoClaw AI Assistant
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=<username>
WorkingDirectory=/path/to/nanoclaw
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
EnvironmentFile=/path/to/nanoclaw/.env

[Install]
WantedBy=multi-user.target
```

2. Enable and start: `systemctl enable nanoclaw && systemctl start nanoclaw`
3. View logs: `journalctl -u nanoclaw -f`

## Testing

After implementation, verify:

**Build and startup:**
1. `npm run build` — TypeScript compiles without errors
2. With only `DISCORD_BOT_TOKEN` set (no WhatsApp auth): Bot starts, connects to Discord, logs "ready" with the bot username, and logs that only the Discord channel is active
3. With only WhatsApp auth (no `DISCORD_BOT_TOKEN`): Bot starts with WhatsApp only — original behavior is preserved
4. With both configured: Both channels start and are logged as active
5. With neither configured: Bot logs an error and exits

**Discord functionality:**
6. Send a message mentioning the bot in a test channel — verify it appears in SQLite with `platform: 'discord'`
7. Verify the agent container spawns and returns a response
8. Verify the response is posted back to the correct Discord channel
9. Test typing indicator appears while the agent is processing
10. Test long responses are split correctly at the 2000-character boundary
11. Test scheduled tasks send messages to the correct Discord channel
12. Verify group isolation — agent in one channel cannot access another channel's filesystem
13. Test the main channel's admin commands (register group, list tasks, etc.)

**Cross-platform (if both channels are active):**
14. **WhatsApp regression:** Verify existing WhatsApp functionality still works — send a WhatsApp message and confirm it is processed and responded to correctly
15. Test that scheduled tasks route to the correct platform based on the group's registered channel type
16. Verify a WhatsApp group and a Discord channel can operate simultaneously without interference

## Rollback

If something goes wrong with the Discord integration:

```bash
git stash  # or git checkout .
npm install  # restore original dependencies
npm run build
```

Since this skill adds Discord as a runtime-togglable channel without removing WhatsApp, you can also simply unset `DISCORD_BOT_TOKEN` from your environment to disable Discord without reverting any code. The WhatsApp channel will continue to function independently.
