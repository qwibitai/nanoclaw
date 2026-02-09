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

## Implementation

### Step 1: Update Configuration

Read `src/config.ts` and add Telegram config exports:

```typescript
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const TELEGRAM_ONLY = process.env.TELEGRAM_ONLY === "true";
```

These should be added near the top with other configuration exports.

### Step 2: Add storeMessageDirect to Database

Read `src/db.ts` and add this function (place it near the `storeMessage` function):

```typescript
/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
  );
}
```

This uses the existing `db` instance from `db.ts`. No additional imports needed.

### Step 3: Create Telegram Module

Create `src/telegram.ts`. The Telegram module is a thin layer that stores incoming messages to the database. It does NOT call the agent directly — the existing `startMessageLoop()` in `src/index.ts` polls all registered group JIDs and picks up Telegram messages automatically.

```typescript
import { Bot } from "grammy";
import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
} from "./config.js";
import {
  getAllRegisteredGroups,
  storeChatMetadata,
  storeMessageDirect,
} from "./db.js";
import { logger } from "./logger.js";

let bot: Bot | null = null;

/** Store a placeholder message for non-text content (photos, voice, etc.) */
function storeNonTextMessage(ctx: any, placeholder: string): void {
  const chatId = `tg:${ctx.chat.id}`;
  const registeredGroups = getAllRegisteredGroups();
  if (!registeredGroups[chatId]) return;

  const timestamp = new Date(ctx.message.date * 1000).toISOString();
  const senderName =
    ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || "Unknown";
  const caption = ctx.message.caption ? ` ${ctx.message.caption}` : "";

  storeChatMetadata(chatId, timestamp);
  storeMessageDirect({
    id: ctx.message.message_id.toString(),
    chat_jid: chatId,
    sender: ctx.from?.id?.toString() || "",
    sender_name: senderName,
    content: `${placeholder}${caption}`,
    timestamp,
    is_from_me: false,
  });
}

export async function connectTelegram(botToken: string): Promise<void> {
  bot = new Bot(botToken);

  // Command to get chat ID (useful for registration)
  bot.command("chatid", (ctx) => {
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
  bot.command("ping", (ctx) => {
    ctx.reply(`${ASSISTANT_NAME} is online.`);
  });

  bot.on("message:text", async (ctx) => {
    // Skip commands
    if (ctx.message.text.startsWith("/")) return;

    const chatId = `tg:${ctx.chat.id}`;
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
        : (ctx.chat as any).title || chatId;

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
    storeChatMetadata(chatId, timestamp, chatName);

    // Check if this chat is registered
    const registeredGroups = getAllRegisteredGroups();
    const group = registeredGroups[chatId];

    if (!group) {
      logger.debug(
        { chatId, chatName },
        "Message from unregistered Telegram chat",
      );
      return;
    }

    // Store message — startMessageLoop() will pick it up
    storeMessageDirect({
      id: msgId,
      chat_jid: chatId,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatId, chatName, sender: senderName },
      "Telegram message stored",
    );
  });

  // Handle non-text messages with placeholders so the agent knows something was sent
  bot.on("message:photo", (ctx) => storeNonTextMessage(ctx, "[Photo]"));
  bot.on("message:video", (ctx) => storeNonTextMessage(ctx, "[Video]"));
  bot.on("message:voice", (ctx) => storeNonTextMessage(ctx, "[Voice message]"));
  bot.on("message:audio", (ctx) => storeNonTextMessage(ctx, "[Audio]"));
  bot.on("message:document", (ctx) => {
    const name = ctx.message.document?.file_name || "file";
    storeNonTextMessage(ctx, `[Document: ${name}]`);
  });
  bot.on("message:sticker", (ctx) => {
    const emoji = ctx.message.sticker?.emoji || "";
    storeNonTextMessage(ctx, `[Sticker ${emoji}]`);
  });
  bot.on("message:location", (ctx) => storeNonTextMessage(ctx, "[Location]"));
  bot.on("message:contact", (ctx) => storeNonTextMessage(ctx, "[Contact]"));

  // Handle errors gracefully
  bot.catch((err) => {
    logger.error({ err: err.message }, "Telegram bot error");
  });

  // Start polling
  bot.start({
    onStart: (botInfo) => {
      logger.info(
        { username: botInfo.username, id: botInfo.id },
        "Telegram bot connected",
      );
      console.log(`\n  Telegram bot: @${botInfo.username}`);
      console.log(
        `  Send /chatid to the bot to get a chat's registration ID\n`,
      );
    },
  });
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
): Promise<void> {
  if (!bot) {
    logger.warn("Telegram bot not initialized");
    return;
  }

  try {
    const numericId = chatId.replace(/^tg:/, "");

    // Telegram has a 4096 character limit per message — split if needed
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await bot.api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await bot.api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info({ chatId, length: text.length }, "Telegram message sent");
  } catch (err) {
    logger.error({ chatId, err }, "Failed to send Telegram message");
  }
}

export async function setTelegramTyping(chatId: string): Promise<void> {
  if (!bot) return;
  try {
    const numericId = chatId.replace(/^tg:/, "");
    await bot.api.sendChatAction(numericId, "typing");
  } catch (err) {
    logger.debug({ chatId, err }, "Failed to send Telegram typing indicator");
  }
}

export function isTelegramConnected(): boolean {
  return bot !== null;
}

export function stopTelegram(): void {
  if (bot) {
    bot.stop();
    bot = null;
    logger.info("Telegram bot stopped");
  }
}
```

Key differences from WhatsApp message handling:
- No `onMessage` callback — messages are stored to DB and the existing message loop picks them up
- Registration check uses `getAllRegisteredGroups()` from `db.ts` directly
- Trigger matching is handled by `startMessageLoop()` / `processGroupMessages()`, not the Telegram module

### Step 4: Update Main Application

Modify `src/index.ts`:

1. **Add imports** at the top:

```typescript
import {
  connectTelegram,
  sendTelegramMessage,
  setTelegramTyping,
  stopTelegram,
} from "./telegram.js";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_ONLY } from "./config.js";
```

2. **Update `sendMessage` function** to route Telegram messages. Find the `sendMessage` function and add a `tg:` prefix check before the WhatsApp path:

```typescript
async function sendMessage(jid: string, text: string): Promise<void> {
  // Route Telegram messages directly (no outgoing queue needed)
  if (jid.startsWith("tg:")) {
    await sendTelegramMessage(jid, text);
    return;
  }

  // WhatsApp path (with outgoing queue for reconnection)
  if (!waConnected) {
    outgoingQueue.push({ jid, text });
    logger.info({ jid, length: text.length, queueSize: outgoingQueue.length }, 'WA disconnected, message queued');
    return;
  }
  try {
    await sock.sendMessage(jid, { text });
    logger.info({ jid, length: text.length }, 'Message sent');
  } catch (err) {
    outgoingQueue.push({ jid, text });
    logger.warn({ jid, err, queueSize: outgoingQueue.length }, 'Failed to send, message queued');
  }
}
```

3. **Update `setTyping` function** to route Telegram typing indicators:

```typescript
async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  if (jid.startsWith("tg:")) {
    if (isTyping) await setTelegramTyping(jid);
    return;
  }
  try {
    await sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
  } catch (err) {
    logger.debug({ jid, err }, 'Failed to update typing status');
  }
}
```

4. **Update `main()` function**. Add Telegram startup before `connectWhatsApp()` and wrap WhatsApp in a `TELEGRAM_ONLY` check:

```typescript
async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopTelegram();
    await queue.shutdown(10000);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start Telegram bot if configured (independent of WhatsApp)
  const hasTelegram = !!TELEGRAM_BOT_TOKEN;
  if (hasTelegram) {
    await connectTelegram(TELEGRAM_BOT_TOKEN);
  }

  if (!TELEGRAM_ONLY) {
    await connectWhatsApp();
  } else {
    // Telegram-only mode: start all services that WhatsApp's connection.open normally starts
    startSchedulerLoop({
      registeredGroups: () => registeredGroups,
      getSessions: () => sessions,
      queue,
      onProcess: (groupJid, proc, containerName, groupFolder) =>
        queue.registerProcess(groupJid, proc, containerName, groupFolder),
      sendMessage,
      assistantName: ASSISTANT_NAME,
    });
    startIpcWatcher();
    queue.setProcessMessagesFn(processGroupMessages);
    recoverPendingMessages();
    startMessageLoop();
    logger.info(
      `NanoClaw running (Telegram-only, trigger: @${ASSISTANT_NAME})`,
    );
  }
}
```

Note: When running alongside WhatsApp, the `connection.open` handler in `connectWhatsApp()` already starts the scheduler, IPC watcher, queue, and message loop — no duplication needed.

5. **Update `getAvailableGroups` function** to include Telegram chats. The current filter only shows WhatsApp groups (`@g.us`). Update it to also include `tg:` chats so the agent can discover and register Telegram chats via IPC:

```typescript
function getAvailableGroups(): AvailableGroup[] {
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

### Step 5: Update Environment

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

### Step 6: Register a Telegram Chat

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

### Step 7: Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Or for systemd:

```bash
npm run build
systemctl --user restart nanoclaw
```

### Step 8: Test

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
3. The WhatsApp connection code is automatically skipped
4. All services (scheduler, IPC watcher, queue, message loop) start independently
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

## Removal

To remove Telegram integration:

1. Delete `src/telegram.ts`
2. Remove Telegram imports from `src/index.ts`
3. Remove `sendTelegramMessage` / `setTelegramTyping` routing from `sendMessage()` and `setTyping()` functions
4. Remove `connectTelegram()` / `stopTelegram()` calls from `main()`
5. Remove `TELEGRAM_ONLY` conditional in `main()`
6. Revert `getAvailableGroups()` filter to only include `@g.us` chats
7. Remove `storeMessageDirect` from `src/db.ts`
8. Remove Telegram config (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ONLY`) from `src/config.ts`
9. Remove Telegram registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'tg:%'"`
10. Uninstall: `npm uninstall grammy`
11. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
