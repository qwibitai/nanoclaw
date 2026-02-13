---
name: add-telegram
description: Add Telegram as a channel. Can replace WhatsApp entirely or run alongside it. Also configurable as a control-only channel (triggers actions) or passive channel (receives notifications only).
---

# Add Telegram Channel

This skill adds Telegram support to NanoClaw. Users can choose to:

1. **Replace WhatsApp** - Use Telegram as the only messaging channel
2. **Add alongside WhatsApp** - Both channels active
3. **Control channel** - Telegram triggers agent but doesn't receive all outputs
4. **Notification channel** - Receives outputs but limited triggering

## Prerequisites

### 1. Install Grammy

```bash
npm install grammy
```

Grammy is a modern, TypeScript-first Telegram bot framework.

### 2. Create Telegram Bot

Tell the user:

> I need you to create a Telegram bot:
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/newbot` and follow prompts:
>    - Bot name: Something friendly (e.g., "Andy Assistant")
>    - Bot username: Must end with "bot" (e.g., "andy_ai_bot")
> 3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

Wait for user to provide the token.

### 3. Get Chat ID

Tell the user:

> To register a chat, you need its Chat ID. Here's how:
>
> **For Private Chat (DM with bot):**
> 1. Search for your bot in Telegram
> 2. Start a chat and send any message
> 3. I'll add a `/chatid` command to help you get the ID
>
> **For Group Chat:**
> 1. Add your bot to the group
> 2. Send any message
> 3. Use the `/chatid` command in the group

### 4. Disable Group Privacy (for group chats)

Tell the user:

> **Important for group chats**: By default, Telegram bots in groups only receive messages that @mention the bot or are commands. To let the bot see all messages (needed for `requiresTrigger: false` or trigger-word detection):
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/mybots` and select your bot
> 3. Go to **Bot Settings** > **Group Privacy**
> 4. Select **Turn off**
>
> Without this, the bot will only see messages that directly @mention it.

This step is optional if the user only wants trigger-based responses via @mentioning the bot.

## Questions to Ask

Before making changes, ask:

1. **Mode**: Replace WhatsApp or add alongside it?
   - If replace: Set `TELEGRAM_ONLY=true`
   - If alongside: Both will run

2. **Chat behavior**: Should this chat respond to all messages or only when @mentioned?
   - Main chat: Responds to all (set `requiresTrigger: false`)
   - Other chats: Default requires trigger (`requiresTrigger: true`)

## Architecture

NanoClaw uses a **Channel abstraction** (`Channel` interface in `src/types.ts`). Each messaging platform implements this interface. Key files:

| File | Purpose |
|------|---------|
| `src/types.ts` | `Channel` interface definition |
| `src/channels/whatsapp.ts` | `WhatsAppChannel` class (reference implementation) |
| `src/router.ts` | `findChannel()`, `routeOutbound()`, `formatOutbound()` |
| `src/index.ts` | Orchestrator: creates channels, wires callbacks, starts subsystems |
| `src/ipc.ts` | IPC watcher (uses `sendMessage` dep for outbound) |

The Telegram channel follows the same pattern as WhatsApp:
- Implements `Channel` interface (`connect`, `sendMessage`, `ownsJid`, `disconnect`, `setTyping`)
- Delivers inbound messages via `onMessage` / `onChatMetadata` callbacks
- The existing message loop in `src/index.ts` picks up stored messages automatically

## Implementation

### Step 1: Update Configuration

Read `src/config.ts` and add Telegram config exports:

```typescript
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_ONLY = process.env.TELEGRAM_ONLY === "true";
```

These should be added near the top with other configuration exports.

### Step 2: Create Telegram Channel

Create `src/channels/telegram.ts` implementing the `Channel` interface. Use `src/channels/whatsapp.ts` as a reference for the pattern.

```typescript
import { Bot } from "grammy";

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
} from "../config.js";
import { logger } from "../logger.js";
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from "../types.js";

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = "telegram";
  prefixAssistantName = false; // Telegram bots already display their name

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command("chatid", (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === "private"
          ? ctx.from?.first_name || "Private"
          : (ctx.chat as any).title || "Unknown";

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: "Markdown" },
      );
    });

    // Command to check bot status
    this.bot.command("ping", (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on("message:text", async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith("/")) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        "Unknown";
      const sender = ctx.from?.id.toString() || "";
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === "private"
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === "mention") {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          "Message from unregistered Telegram chat",
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        "Telegram message stored",
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || "Unknown";
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : "";

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || "",
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on("message:photo", (ctx) => storeNonText(ctx, "[Photo]"));
    this.bot.on("message:video", (ctx) => storeNonText(ctx, "[Video]"));
    this.bot.on("message:voice", (ctx) => storeNonText(ctx, "[Voice message]"));
    this.bot.on("message:audio", (ctx) => storeNonText(ctx, "[Audio]"));
    this.bot.on("message:document", (ctx) => {
      const name = ctx.message.document?.file_name || "file";
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on("message:sticker", (ctx) => {
      const emoji = ctx.message.sticker?.emoji || "";
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on("message:location", (ctx) => storeNonText(ctx, "[Location]"));
    this.bot.on("message:contact", (ctx) => storeNonText(ctx, "[Contact]"));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, "Telegram bot error");
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            "Telegram bot connected",
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn("Telegram bot not initialized");
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, "");

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, "Telegram message sent");
    } catch (err) {
      logger.error({ jid, err }, "Failed to send Telegram message");
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith("tg:");
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info("Telegram bot stopped");
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, "");
      await this.bot.api.sendChatAction(numericId, "typing");
    } catch (err) {
      logger.debug({ jid, err }, "Failed to send Telegram typing indicator");
    }
  }
}
```

Key differences from the old standalone `src/telegram.ts`:
- Implements `Channel` interface — same pattern as `WhatsAppChannel`
- Uses `onMessage` / `onChatMetadata` callbacks instead of importing DB functions directly
- Registration check via `registeredGroups()` callback, not `getAllRegisteredGroups()`
- `prefixAssistantName = false` — Telegram bots already show their name, so `formatOutbound()` skips the prefix
- No `storeMessageDirect` needed — `storeMessage()` in db.ts already accepts `NewMessage` directly

### Step 3: Update Main Application

Modify `src/index.ts` to support multiple channels. Read the file first to understand the current structure.

1. **Add imports** at the top:

```typescript
import { TelegramChannel } from "./channels/telegram.js";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_ONLY } from "./config.js";
import { findChannel } from "./router.js";
```

2. **Add a channels array** alongside the existing `whatsapp` variable:

```typescript
let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
```

Import `Channel` from `./types.js` if not already imported.

3. **Update `processGroupMessages`** to find the correct channel for the JID instead of using `whatsapp` directly. Replace the direct `whatsapp.setTyping()` and `whatsapp.sendMessage()` calls:

```typescript
// Find the channel that owns this JID
const channel = findChannel(channels, chatJid);
if (!channel) return true; // No channel for this JID

// ... (existing code for message fetching, trigger check, formatting)

await channel.setTyping?.(chatJid, true);
// ... (existing agent invocation, replacing whatsapp.sendMessage with channel.sendMessage)
await channel.setTyping?.(chatJid, false);
```

In the `onOutput` callback inside `processGroupMessages`, replace:
```typescript
await whatsapp.sendMessage(chatJid, `${ASSISTANT_NAME}: ${text}`);
```
with:
```typescript
const formatted = formatOutbound(channel, text);
if (formatted) await channel.sendMessage(chatJid, formatted);
```

4. **Update `main()` function** to create channels conditionally and use them for deps:

```typescript
async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string) =>
      storeChatMetadata(chatJid, timestamp, name),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  if (!TELEGRAM_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  if (TELEGRAM_BOT_TOKEN) {
    const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, channelOpts);
    channels.push(telegram);
    await telegram.connect();
  }

  // Start subsystems
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) return;
      const text = formatOutbound(channel, rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop();
}
```

5. **Update `getAvailableGroups`** to include Telegram chats:

```typescript
export function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && (c.jid.endsWith('@g.us') || c.jid.startsWith('tg:')))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}
```

### Step 4: Update Environment

Add to `.env`:

```bash
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN_HERE

# Optional: Set to "true" to disable WhatsApp entirely
# TELEGRAM_ONLY=true
```

**Important**: After modifying `.env`, sync to the container environment:

```bash
cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Step 5: Register a Telegram Chat

After installing and starting the bot, tell the user:

> 1. Send `/chatid` to your bot (in private chat or in a group)
> 2. Copy the chat ID (e.g., `tg:123456789` or `tg:-1001234567890`)
> 3. I'll register it for you

Registration uses the `registerGroup()` function in `src/index.ts`, which writes to SQLite and creates the group folder structure. Call it like this (or add a one-time script):

```typescript
// For private chat (main group):
registerGroup("tg:123456789", {
  name: "Personal",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false, // main group responds to all messages
});

// For group chat (note negative ID for Telegram groups):
registerGroup("tg:-1001234567890", {
  name: "My Telegram Group",
  folder: "telegram-group",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true, // only respond when triggered
});
```

The `RegisteredGroup` type requires a `trigger` string field and has an optional `requiresTrigger` boolean (defaults to `true`). Set `requiresTrigger: false` for chats that should respond to all messages.

Alternatively, if the agent is already running in the main group, it can register new groups via IPC using the `register_group` task type.

### Step 6: Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Or for systemd:

```bash
npm run build
systemctl --user restart nanoclaw
```

### Step 7: Test

Tell the user:

> Send a message to your registered Telegram chat:
> - For main chat: Any message works
> - For non-main: `@Andy hello` or @mention the bot
>
> Check logs: `tail -f logs/nanoclaw.log`

## Replace WhatsApp Entirely

If user wants Telegram-only:

1. Set `TELEGRAM_ONLY=true` in `.env`
2. Run `cp .env data/env/env` to sync to container
3. The WhatsApp channel is not created — only Telegram
4. All services (scheduler, IPC watcher, queue, message loop) start normally
5. Optionally remove `@whiskeysockets/baileys` dependency (but it's harmless to keep)

## Features

### Chat ID Formats

- **WhatsApp**: `120363336345536173@g.us` (groups) or `1234567890@s.whatsapp.net` (DM)
- **Telegram**: `tg:123456789` (positive for private) or `tg:-1001234567890` (negative for groups)

### Trigger Options

The bot responds when:
1. Chat has `requiresTrigger: false` in its registration (e.g., main group)
2. Bot is @mentioned in Telegram (translated to TRIGGER_PATTERN automatically)
3. Message matches TRIGGER_PATTERN directly (e.g., starts with @Andy)

Telegram @mentions (e.g., `@andy_ai_bot`) are automatically translated: if the bot is @mentioned and the message doesn't already match TRIGGER_PATTERN, the trigger prefix is prepended before storing. This ensures @mentioning the bot always triggers a response.

**Group Privacy**: The bot must have Group Privacy disabled in BotFather to see non-mention messages in groups. See Prerequisites step 4.

### Commands

- `/chatid` - Get chat ID for registration
- `/ping` - Check if bot is online

## Troubleshooting

### Bot not responding

Check:
1. `TELEGRAM_BOT_TOKEN` is set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite (check with: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'tg:%'"`)
3. For non-main chats: message includes trigger pattern
4. Service is running: `launchctl list | grep nanoclaw`

### Bot only responds to @mentions in groups

The bot has Group Privacy enabled (default). It can only see messages that @mention it or are commands. To fix:
1. Open `@BotFather` in Telegram
2. `/mybots` > select bot > **Bot Settings** > **Group Privacy** > **Turn off**
3. Remove and re-add the bot to the group (required for the change to take effect)

### Getting chat ID

If `/chatid` doesn't work:
- Verify bot token is valid: `curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"`
- Check bot is started: `tail -f logs/nanoclaw.log`

### Service conflicts

If running `npm run dev` while launchd service is active:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Agent Swarms (Teams)

After completing the Telegram setup, ask the user:

> Would you like to add Agent Swarm support? Without it, Agent Teams still work — they just operate behind the scenes. With Swarm support, each subagent appears as a different bot in the Telegram group so you can see who's saying what and have interactive team sessions.

If they say yes, invoke the `/add-telegram-swarm` skill.

## Removal

To remove Telegram integration:

1. Delete `src/channels/telegram.ts`
2. Remove `TelegramChannel` import and creation from `src/index.ts`
3. Remove `channels` array and revert to using `whatsapp` directly in `processGroupMessages`, scheduler deps, and IPC deps
4. Revert `getAvailableGroups()` filter to only include `@g.us` chats
5. Remove Telegram config (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ONLY`) from `src/config.ts`
6. Remove Telegram registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'tg:%'"`
7. Uninstall: `npm uninstall grammy`
8. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
