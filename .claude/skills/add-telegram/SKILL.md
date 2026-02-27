---
name: add-telegram
description: Add Telegram as a channel. Can replace WhatsApp entirely or run alongside it. Also configurable as a control-only channel (triggers actions) or passive channel (receives notifications only).
---

# Add Telegram Channel

This skill adds Telegram support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `telegram` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Should Telegram replace WhatsApp or run alongside it?
- **Replace WhatsApp** - Telegram will be the only channel (sets TELEGRAM_ONLY=true)
- **Alongside** - Both Telegram and WhatsApp channels active

AskUserQuestion: Do you have a Telegram bot token, or do you need to create one?

If they have one, collect it now. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-telegram
```

This deterministically:
- Adds `src/channels/telegram.ts` (TelegramChannel class implementing Channel interface, with Markdown→HTML rendering and file download support)
- Adds `src/channels/telegram.test.ts` (46 unit tests)
- Three-way merges Telegram support into `src/index.ts` (multi-channel support, findChannel routing, typing indicator interval pattern)
- Three-way merges Telegram config into `src/config.ts` (TELEGRAM_BOT_TOKEN, TELEGRAM_ONLY exports)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Installs the `grammy` npm dependency
- Updates `.env.example` with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ONLY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new telegram tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Telegram Bot (if needed)

If the user doesn't have a bot token, tell them:

> I need you to create a Telegram bot:
>
> 1. Open Telegram and search for `@BotFather`
> 2. Send `/newbot` and follow prompts:
>    - Bot name: Something friendly (e.g., "Andy Assistant")
>    - Bot username: Must end with "bot" (e.g., "andy_ai_bot")
> 3. Copy the bot token (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

Wait for the user to provide the token.

### Configure environment

Add to `.env`:

```bash
TELEGRAM_BOT_TOKEN=<their-token>
```

If they chose to replace WhatsApp:

```bash
TELEGRAM_ONLY=true
```

**Critical on Linux with systemd**: The service does NOT inherit the shell environment. All credentials must be in `.env`.

Sync to container environment:

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
npm run build
```

On macOS (launchd):
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

On Linux (systemd):
```bash
systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Open your bot in Telegram (search for its username)
> 2. Send `/chatid` — it will reply with the chat ID
> 3. For groups: add the bot to the group first, then send `/chatid` in the group

Wait for the user to provide the chat ID (format: `tg:123456789` or `tg:-1001234567890`).

### Register the chat

Use the IPC register flow or register directly. The simplest approach on an already-running system is a one-time CJS script (avoids ESM module resolution issues, and uses the correct DB column name `trigger_pattern`):

```javascript
// register-chat.cjs — run with: node register-chat.cjs
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const JID = 'tg:YOUR_CHAT_ID_HERE';
const GROUP_NAME = 'Personal';
const FOLDER = 'main';
const TRIGGER = '@Andy';
const REQUIRES_TRIGGER = false; // false = respond to all messages

const db = new Database(path.join(__dirname, 'store/messages.db'));
fs.mkdirSync(path.join(__dirname, 'groups', FOLDER, 'logs'), { recursive: true });
db.prepare(`
  INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, requires_trigger, added_at)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(JID, GROUP_NAME, FOLDER, TRIGGER, REQUIRES_TRIGGER ? 1 : 0, new Date().toISOString());
console.log('Registered:', JID, '->', GROUP_NAME);
db.close();
```

Alternatively, use the `registerGroup()` function in `src/index.ts` at runtime, or the IPC `register_group` task type if the agent is already running.

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

## Linux / Docker Considerations

When running on Linux with Docker (rather than macOS with Apple Container), additional care is needed.

### IPC directory permissions

The host process runs as root, but Docker containers run as the `node` user (uid 1000). IPC directories and files must be world-writable. Ensure `src/container-runner.ts` creates IPC dirs with `mode: 0o777` and `src/group-queue.ts` writes files with `mode: 0o666`. If you see `EACCES` errors in container logs:

```bash
chmod -R 777 data/ipc/
chmod -R 777 data/sessions/
```

### Session directory permissions

The per-group `.claude` sessions directory is created by the host as root. If the container can't create subdirectories (e.g., `.claude/debug/`), fix with:

```bash
chmod -R 777 data/sessions/
```

## Troubleshooting

### Bot not responding

Check:
1. Check `TELEGRAM_BOT_TOKEN` is set in `.env` AND synced to `data/env/env`
2. **Linux/systemd**: Shell env vars are not inherited by the service — credentials must be in `.env`
3. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'tg:%'"`
4. For non-main chats: message must include trigger pattern
5. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### "Not logged in · Please run /login"

The agent can't authenticate with Anthropic. Causes:

1. **Credentials not in `.env`** — add `ANTHROPIC_API_KEY` to `.env`
2. **Session dir permissions** — run `chmod -R 777 data/sessions/`

### Typing indicator never stops

The skill already applies the interval + `stopTyping()` pattern via `modify/src/index.ts`. If you see this issue after applying the skill, ensure the build is up to date: `npm run build`.

### Container can't process IPC messages (permission errors)

See "Linux / Docker Considerations" above. Quick fix: `chmod -R 777 data/ipc/`

### Bot only responds to @mentions in groups

Group Privacy is enabled (default). Fix:
1. `@BotFather` > `/mybots` > select bot > **Bot Settings** > **Group Privacy** > **Turn off**
2. Remove and re-add the bot to the group (required for the change to take effect)

### Getting chat ID

If `/chatid` doesn't work:
- Verify token: `curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"`
- Check bot is started: `tail -f logs/nanoclaw.log`

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Agent Swarms (Teams)

After completing the Telegram setup, use `AskUserQuestion`:

AskUserQuestion: Would you like to add Agent Swarm support? Without it, Agent Teams still work — they just operate behind the scenes. With Swarm support, each subagent appears as a different bot in the Telegram group so you can see who's saying what and have interactive team sessions.

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
8. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
