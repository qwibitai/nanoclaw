---
name: add-telegram
description: Add Telegram as an input channel for NanoClaw using the grammy library. Messages in Telegram can trigger the agent, and responses are sent back to Telegram. Guides through BotFather setup and implements the integration.
---

# Add Telegram Channel

This skill adds Telegram as an input channel for NanoClaw. Users can message a Telegram bot to interact with the agent, in addition to (or instead of) WhatsApp.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Initial Questions

Ask the user:

> How do you want Telegram to work with NanoClaw?
>
> **Option A: Separate Channel**
> - Telegram messages go to a dedicated "telegram" group context
> - Separate conversation history from WhatsApp
>
> **Option B: Shared Context**
> - Telegram messages share the main group context
> - Agent remembers conversations from both WhatsApp and Telegram

Store their choice for implementation.

---

## Prerequisites

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool** to present this:

> You'll need a Telegram Bot Token from BotFather.
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/newbot` and follow the prompts
> 3. Choose a name (e.g., "NanoClaw") and username (e.g., "nanoclaw_bot")
> 4. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
>
> Do you have your bot token ready?

Wait for user confirmation and the token.

---

## Implementation

### Step 1: Add grammy Dependency

Read `package.json` and add the `grammy` package to dependencies:

```json
"dependencies": {
  ...existing dependencies...
  "grammy": "^1.31.0"
}
```

Then install it:

```bash
npm install
```

### Step 2: Add Telegram Configuration

Read `src/config.ts` and add these exports:

```typescript
// Telegram bot configuration
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_ENABLED = !!TELEGRAM_BOT_TOKEN;
```

Add the token to `.env`:

```bash
echo "TELEGRAM_BOT_TOKEN=<token_from_user>" >> .env
```

Add `TELEGRAM_BOT_TOKEN` to the list of allowed env vars in `src/container-runner.ts` in the `buildVolumeMounts` function, in the `allowedVars` array:

```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN'];
```

### Step 3: Create Telegram Module

Create `src/telegram.ts`:

```typescript
import { Bot, Context } from 'grammy';
import { ASSISTANT_NAME, TELEGRAM_BOT_TOKEN, TELEGRAM_ENABLED, TRIGGER_PATTERN } from './config.js';
import { storeChatMetadata, storeMessage } from './db.js';
import { logger } from './logger.js';

let bot: Bot | null = null;

interface TelegramCallbacks {
  onMessage: (chatId: string, text: string, senderName: string) => Promise<string | null>;
}

export function isTelegramEnabled(): boolean {
  return TELEGRAM_ENABLED;
}

export async function startTelegramBot(callbacks: TelegramCallbacks): Promise<void> {
  if (!TELEGRAM_ENABLED) {
    logger.info('Telegram bot disabled (no TELEGRAM_BOT_TOKEN)');
    return;
  }

  bot = new Bot(TELEGRAM_BOT_TOKEN);

  bot.on('message:text', async (ctx: Context) => {
    const text = ctx.message?.text;
    const chatId = ctx.chat?.id?.toString();
    const senderName = ctx.from?.first_name || ctx.from?.username || 'Unknown';

    if (!text || !chatId) return;

    const telegramJid = `telegram:${chatId}`;

    // Store chat metadata for discovery
    storeChatMetadata(telegramJid, new Date().toISOString());

    logger.info({ chatId, senderName, length: text.length }, 'Telegram message received');

    // For shared context mode, always trigger; for separate mode, require trigger or private chat
    const isPrivateChat = ctx.chat?.type === 'private';
    const shouldTrigger = isPrivateChat || TRIGGER_PATTERN.test(text);

    if (!shouldTrigger) return;

    // Send typing indicator
    await ctx.replyWithChatAction('typing');

    try {
      const response = await callbacks.onMessage(telegramJid, text, senderName);

      if (response) {
        // Split long messages (Telegram has 4096 char limit)
        const MAX_LENGTH = 4096;
        if (response.length <= MAX_LENGTH) {
          await ctx.reply(response);
        } else {
          const chunks: string[] = [];
          for (let i = 0; i < response.length; i += MAX_LENGTH) {
            chunks.push(response.slice(i, i + MAX_LENGTH));
          }
          for (const chunk of chunks) {
            await ctx.reply(chunk);
          }
        }
      }
    } catch (err) {
      logger.error({ err, chatId }, 'Error processing Telegram message');
      await ctx.reply('Sorry, something went wrong processing your message.');
    }
  });

  bot.catch((err) => {
    logger.error({ err: err.error }, 'Telegram bot error');
  });

  await bot.start();
  logger.info('Telegram bot started');
}

export async function stopTelegramBot(): Promise<void> {
  if (bot) {
    await bot.stop();
    logger.info('Telegram bot stopped');
  }
}
```

### Step 4: Integrate with Main Application

Read `src/index.ts` and add these changes:

**Add imports at the top:**

```typescript
import { isTelegramEnabled, startTelegramBot } from './telegram.js';
```

**Add Telegram handler function** (near the `runAgent` function):

```typescript
async function handleTelegramMessage(
  telegramJid: string,
  text: string,
  senderName: string,
): Promise<string | null> {
  // Use the configured group context (shared or separate)
  // For shared context, use main group; for separate, use a telegram group
  const TELEGRAM_GROUP_FOLDER = 'telegram'; // or MAIN_GROUP_FOLDER for shared

  // Find or create telegram group registration
  let group = registeredGroups[telegramJid];
  if (!group) {
    // Auto-register telegram chats
    group = {
      name: `Telegram ${telegramJid}`,
      folder: TELEGRAM_GROUP_FOLDER,
      trigger: ASSISTANT_NAME,
      added_at: new Date().toISOString(),
    };
    registerGroup(telegramJid, group);
  }

  return runAgent(group, `<message sender="${senderName}">${text}</message>`, telegramJid);
}
```

**Start Telegram bot in the `connection === 'open'` block**, after `startMessageLoop()`:

```typescript
if (isTelegramEnabled()) {
  startTelegramBot({
    onMessage: handleTelegramMessage,
  }).catch((err) => logger.error({ err }, 'Failed to start Telegram bot'));
}
```

### Step 5: Create Telegram Group Directory

```bash
mkdir -p groups/telegram/logs
```

Write `groups/telegram/CLAUDE.md`:

```markdown
# Telegram Channel

You are responding to messages from Telegram. Your responses will be sent back to the Telegram chat.

## Guidelines

- Keep responses concise (Telegram has a 4096 character limit per message)
- You can use Markdown formatting (Telegram supports it)
- If you need to send code, use backtick code blocks
```

### Step 6: Update Global Memory

Append to `groups/CLAUDE.md`:

```markdown

## Telegram

You can receive messages from Telegram users. Telegram messages appear in your context the same way as WhatsApp messages. Respond naturally - your response will be sent back to the Telegram chat.
```

### Step 7: Build and Restart

```bash
npm run build
```

If using launchd (macOS):

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Or if running manually, restart the process.

### Step 8: Test

Tell the user:

> Telegram bot is now active! Test it by:
>
> 1. Open Telegram and search for your bot by username
> 2. Send it a message like "Hello"
> 3. The agent should respond within a few seconds
>
> In group chats, use the trigger word (e.g., `@Andy hello`).
> In private chats, the trigger word is not required.

Monitor logs:

```bash
tail -f logs/nanoclaw.log | grep -i telegram
```

---

## Troubleshooting

### Bot not responding

- Verify the bot token is correct in `.env`
- Check logs: `tail -100 logs/nanoclaw.log | grep -i telegram`
- Make sure the bot is not running elsewhere (only one instance can poll)

### "409: Conflict" error

Another instance of the bot is running. Stop all other instances first.

### Messages not being stored

Check that `storeChatMetadata` is being called. The telegram JID format is `telegram:<chat_id>`.

---

## Removing Telegram

1. Remove from `package.json`:
   ```bash
   npm uninstall grammy
   ```

2. Delete `src/telegram.ts`

3. Remove Telegram imports and handler from `src/index.ts`

4. Remove `TELEGRAM_BOT_TOKEN` from `.env` and `src/config.ts`

5. Delete `groups/telegram/` directory

6. Rebuild:
   ```bash
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
