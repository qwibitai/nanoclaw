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

## Questions to Ask

Before making changes, ask:

1. **Mode**: Replace WhatsApp or add alongside it?
   - If replace: Set `TELEGRAM_ONLY=true`
   - If alongside: Both will run

2. **Chat behavior**: Should this chat respond to all messages or only when @mentioned?
   - Main chat: Responds to all
   - Other chats: Can configure `respondToAll: true` in registered_groups.json

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

Also update the db.ts exports to include `storeMessageDirect`.

### Step 3: Create Telegram Module

Create `src/telegram.ts` with this content:

```typescript
import { Bot } from "grammy";
import pino from "pino";
import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
  MAIN_GROUP_FOLDER,
} from "./config.js";
import { RegisteredGroup, NewMessage } from "./types.js";
import { storeChatMetadata, storeMessageDirect } from "./db.js";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: { target: "pino-pretty", options: { colorize: true } },
});

export interface TelegramCallbacks {
  onMessage: (
    msg: NewMessage,
    group: RegisteredGroup,
  ) => Promise<string | null>;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
}

let bot: Bot | null = null;
let callbacks: TelegramCallbacks | null = null;

export async function connectTelegram(
  botToken: string,
  cbs: TelegramCallbacks,
): Promise<void> {
  callbacks = cbs;
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
    const content = ctx.message.text;
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

    // Store chat metadata for discovery
    storeChatMetadata(chatId, timestamp, chatName);

    // Check if this chat is registered
    const registeredGroups = callbacks!.getRegisteredGroups();
    const group = registeredGroups[chatId];

    if (!group) {
      logger.debug(
        { chatId, chatName },
        "Message from unregistered Telegram chat",
      );
      return;
    }

    // Store message for registered chats
    storeMessageDirect({
      id: msgId,
      chat_jid: chatId,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    const isMain = group.folder === MAIN_GROUP_FOLDER;
    const respondToAll = (group as any).respondToAll === true;

    // Check if bot is @mentioned in the message (Telegram native mention)
    const botUsername = ctx.me?.username?.toLowerCase();
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

    // Respond if: main group, respondToAll group, bot is @mentioned, or trigger pattern matches
    if (
      !isMain &&
      !respondToAll &&
      !isBotMentioned &&
      !TRIGGER_PATTERN.test(content)
    ) {
      return;
    }

    logger.info(
      { chatId, chatName, sender: senderName },
      "Processing Telegram message",
    );

    // Send typing indicator
    await ctx.replyWithChatAction("typing");

    const msg: NewMessage = {
      id: msgId,
      chat_jid: chatId,
      sender,
      sender_name: senderName,
      content,
      timestamp,
    };

    try {
      const response = await callbacks!.onMessage(msg, group);
      if (response) {
        await ctx.reply(`${ASSISTANT_NAME}: ${response}`);
      }
    } catch (err) {
      logger.error({ err, chatId }, "Error processing Telegram message");
    }
  });

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
    // Remove tg: prefix if present
    const numericId = chatId.replace(/^tg:/, "");
    await bot.api.sendMessage(numericId, text);
    logger.info({ chatId, length: text.length }, "Telegram message sent");
  } catch (err) {
    logger.error({ chatId, err }, "Failed to send Telegram message");
  }
}

export function isTelegramConnected(): boolean {
  return bot !== null;
}

export function stopTelegram(): void {
  if (bot) {
    bot.stop();
    bot = null;
    callbacks = null;
    logger.info("Telegram bot stopped");
  }
}
```

### Step 4: Update Main Application

Modify `src/index.ts`:

1. Add imports at the top:

```typescript
import {
  connectTelegram,
  sendTelegramMessage,
  isTelegramConnected,
} from "./telegram.js";
import { TELEGRAM_BOT_TOKEN, TELEGRAM_ONLY } from "./config.js";
```

2. Update `sendMessage` function to route by channel. Find the `sendMessage` function and replace it with:

```typescript
async function sendMessage(jid: string, text: string): Promise<void> {
  if (jid.startsWith("tg:")) {
    await sendTelegramMessage(jid, text);
  } else {
    try {
      await sock.sendMessage(jid, { text });
      logger.info({ jid, length: text.length }, "Message sent");
    } catch (err) {
      logger.error({ jid, err }, "Failed to send message");
    }
  }
}
```

3. Update `main()` function. Find the `main()` function and update it to support Telegram. Add this before the `connectWhatsApp()` call:

```typescript
const hasTelegram = !!TELEGRAM_BOT_TOKEN;

if (hasTelegram) {
  await connectTelegram(TELEGRAM_BOT_TOKEN, {
    onMessage: async (msg, group) => {
      // Get messages since last agent interaction for context
      const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || "";
      const missedMessages = getMessagesSince(
        msg.chat_jid,
        sinceTimestamp,
        ASSISTANT_NAME,
      );

      const lines = missedMessages.map((m) => {
        const escapeXml = (s: string) =>
          s
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
      });
      const prompt = `<messages>\n${lines.join("\n")}\n</messages>`;

      const group = registeredGroups[msg.chat_jid];
      const isMain = group.folder === MAIN_GROUP_FOLDER;

      const output = await runContainerAgent(group, {
        prompt,
        sessionId: sessions[group.folder],
        groupFolder: group.folder,
        chatJid: msg.chat_jid,
        isMain,
        isScheduledTask: false,
      });

      if (output.newSessionId) {
        sessions[group.folder] = output.newSessionId;
        saveJson(path.join(DATA_DIR, "sessions.json"), sessions);
      }

      lastAgentTimestamp[msg.chat_jid] = msg.timestamp;
      saveState();

      return output.status === "success" ? output.result : null;
    },
    getRegisteredGroups: () => registeredGroups,
  });
}
```

4. Wrap the `connectWhatsApp()` call to support Telegram-only mode. Replace:

```typescript
await connectWhatsApp();
```

With:

```typescript
if (!TELEGRAM_ONLY) {
  await connectWhatsApp();
} else {
  // Telegram-only mode: start scheduler and IPC without WhatsApp
  startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
  });
  startIpcWatcher();
  logger.info(
    `NanoClaw running (Telegram-only, trigger: @${ASSISTANT_NAME})`,
  );
}
```

### Step 5: Update Environment

Add to `.env`:

```bash
TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN_HERE

# Optional: Set to "true" to disable WhatsApp entirely
# TELEGRAM_ONLY=true
```

### Step 6: Register a Telegram Chat

After installing and starting the bot, tell the user:

> 1. Send `/chatid` to your bot (in private chat or in a group)
> 2. Copy the chat ID (e.g., `tg:123456789` or `tg:-1001234567890`)
> 3. I'll add it to registered_groups.json

Then update `data/registered_groups.json`:

For private chat:

```json
{
  "tg:123456789": {
    "name": "Personal",
    "folder": "main",
    "trigger": "@Andy",
    "added_at": "2026-02-05T12:00:00.000Z"
  }
}
```

For group chat (note the negative ID for groups):

```json
{
  "tg:-1001234567890": {
    "name": "My Telegram Group",
    "folder": "telegram-group",
    "trigger": "@Andy",
    "added_at": "2026-02-05T12:00:00.000Z",
    "respondToAll": false
  }
}
```

Set `respondToAll: true` if you want the bot to respond to all messages in that chat (not just when @mentioned or triggered).

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
2. The WhatsApp connection code is automatically skipped
3. Optionally remove `@whiskeysockets/baileys` dependency (but it's harmless to keep)

## Features

### Chat ID Formats

- **WhatsApp**: `120363336345536173@g.us` (groups) or `1234567890@s.whatsapp.net` (DM)
- **Telegram**: `tg:123456789` (positive for private) or `tg:-1001234567890` (negative for groups)

### Trigger Options

The bot responds when:
1. Message is in the main chat (folder: "main")
2. Chat has `respondToAll: true` in registered_groups.json
3. Bot is @mentioned using native Telegram mention (e.g., @your_bot_username)
4. Message matches TRIGGER_PATTERN (e.g., starts with @Andy)

### Commands

- `/chatid` - Get chat ID for registration
- `/ping` - Check if bot is online

## Troubleshooting

### Bot not responding

Check:
1. `TELEGRAM_BOT_TOKEN` is set in `.env`
2. Chat is registered in `data/registered_groups.json` with `tg:` prefix
3. For non-main chats: message includes trigger or @mention
4. Service is running: `launchctl list | grep nanoclaw`

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
3. Remove `sendTelegramMessage` logic from `sendMessage()` function
4. Remove `connectTelegram()` call from `main()`
5. Remove `storeMessageDirect` from `src/db.ts`
6. Remove Telegram config from `src/config.ts`
7. Uninstall: `npm uninstall grammy`
8. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
