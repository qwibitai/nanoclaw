---
name: add-telegram
description: Add Telegram as a channel. Can replace WhatsApp entirely or run alongside it. Also configurable as a control-only channel (triggers actions) or passive channel (receives notifications only).
---

# Add Telegram Channel

This skill adds Telegram support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/telegram.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

## Phase 2: Apply Code Changes

### Clone the Telegram channel repo

```bash
git clone https://github.com/qwibitai/nanoclaw-telegram.git /tmp/nanoclaw-telegram
```

### Copy the required files

```bash
cp /tmp/nanoclaw-telegram/src/channels/telegram.ts src/channels/telegram.ts
cp /tmp/nanoclaw-telegram/src/channels/telegram.test.ts src/channels/telegram.test.ts
```

### Add the grammy dependency

Add `grammy` to `package.json` dependencies. Read the cloned repo's `package.json` to get the exact version pinned there, then add it to the local `package.json` with that same version.

### Update the channel barrel file

Append the Telegram import to `src/channels/index.ts`:

```typescript
import './telegram.js';
```

### Clean up the clone

```bash
rm -rf /tmp/nanoclaw-telegram
```

### Validate code changes

```bash
pnpm install
pnpm run build
pnpm exec vitest run src/channels/telegram.test.ts
```

All tests must pass (including the new Telegram tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Telegram Bot (if needed)

Tell the user:

> If you do not already have a Telegram bot token, create one now:
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/newbot` and follow prompts:
>    - Bot name: Something friendly (e.g., "Andy Assistant")
>    - Bot username: Must end with "bot" (e.g., "andy_ai_bot")
> 3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

### Configure environment

Ensure `.env` contains the `TELEGRAM_BOT_TOKEN` variable. If it is not already present, append it:

```bash
echo 'TELEGRAM_BOT_TOKEN=' >> .env
```

Tell the user:

> Open `.env` and fill in your bot token next to `TELEGRAM_BOT_TOKEN=`. Channels auto-enable when their credentials are present — no extra configuration needed.

Once the user confirms the token is set, sync to the container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Disable Group Privacy (for group chats)

Tell the user:

> **Important for group chats**: By default, Telegram bots only see @mentions and commands in groups. To let the bot see all messages:
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/mybots` and select your bot
> 3. Go to **Bot Settings** > **Group Privacy** > **Turn off**
>
> This is optional if you only want trigger-based responses via @mentioning the bot.

### Build and restart

```bash
pnpm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Ensure service is running

The bot must be running to respond to `/chatid`. Build and start the service if it is not already running:

```bash
pnpm run build
```

Then either start the service or run in the foreground:

```bash
# Foreground (for testing):
pnpm run dev

# Or load the service (macOS):
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux: systemctl --user start nanoclaw
```

### Get Chat ID

Tell the user:

> 1. Open your bot in Telegram (search for its username)
> 2. Send `/chatid` — it will reply with the chat ID
> 3. For groups: add the bot to the group first, then send `/chatid` in the group

Wait for the user to provide the chat ID (format: `tg:123456789` or `tg:-1001234567890`).

### Register the chat

The chat ID, name, and folder name are needed. Use `pnpm exec tsx setup/index.ts --step register` with the appropriate flags.

For a main chat (responds to all messages):

```bash
pnpm exec tsx setup/index.ts --step register -- --jid "tg:<chat-id>" --name "<chat-name>" --folder "telegram_main" --trigger "@${ASSISTANT_NAME}" --channel telegram --no-trigger-required --is-main
```

For additional chats (trigger-only):

```bash
pnpm exec tsx setup/index.ts --step register -- --jid "tg:<chat-id>" --name "<chat-name>" --folder "telegram_<group-name>" --trigger "@${ASSISTANT_NAME}" --channel telegram
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Telegram chat:
> - For main chat: Any message works
> - For non-main: `@Andy hello` or @mention the bot
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `TELEGRAM_BOT_TOKEN` is set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite (check with: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'tg:%'"`)
3. For non-main chats: message includes trigger pattern
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Bot only responds to @mentions in groups

Group Privacy is enabled (default). Fix:
1. `@BotFather` > `/mybots` > select bot > **Bot Settings** > **Group Privacy** > **Turn off**
2. Remove and re-add the bot to the group (required for the change to take effect)

### Getting chat ID

If `/chatid` doesn't work:
- Verify token: `curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"`
- Check bot is started: `tail -f logs/nanoclaw.log`

## After Setup

If running `pnpm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
pnpm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# pnpm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove Telegram integration:

1. Delete `src/channels/telegram.ts` and `src/channels/telegram.test.ts`
2. Remove `import './telegram.js'` from `src/channels/index.ts`
3. Remove `TELEGRAM_BOT_TOKEN` from `.env`
4. Remove Telegram registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'tg:%'"`
5. Uninstall: `pnpm remove grammy`
6. Rebuild: `pnpm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `pnpm run build && systemctl --user restart nanoclaw` (Linux)
