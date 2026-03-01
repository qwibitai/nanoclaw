---
name: add-telegram
description: Add Telegram as a channel with Topics/Forum thread support. Can replace WhatsApp entirely or run alongside it. Also configurable as a control-only channel (triggers actions) or passive channel (receives notifications only).
---

# Add Telegram Channel

This skill adds Telegram support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

**Includes support for Telegram Topics (forum threads)** — each topic can be registered as its own isolated group with independent memory and context.

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
- Adds `src/channels/telegram.ts` (TelegramChannel class with Topics support)
  - Topic-aware JID format: `tg:chatid:topicid`
  - `/chatid` command reports topic ID when used inside a thread
  - Inbound and outbound messages routed to/from correct thread
  - Topic registration is opt-in
- Adds `src/channels/telegram.test.ts` (46 unit tests)
- Three-way merges Telegram support into `src/index.ts` (multi-channel support, findChannel routing)
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
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Open your bot in Telegram (search for its username)
> 2. Send `/chatid` — it will reply with the chat ID
> 3. For groups: add the bot to the group first, then send `/chatid` in the group
> 4. **For topics**: Go to the specific topic thread and send `/chatid` there

Wait for the user to provide the chat ID.

**Chat ID formats:**
- Regular chat: `tg:123456789` or `tg:-1001234567890`
- Topic thread: `tg:-1001234567890:20` (includes topic ID after the second colon)

### Register the chat

Registration is done via IPC — write a JSON task file and the host process picks it up immediately (no restart needed). Then create the group folder.

**Main chat** (responds to all messages, no trigger needed):

```bash
echo '{
  "type": "register_group",
  "jid": "tg:<chat-id>",
  "name": "<chat-name>",
  "folder": "main",
  "trigger": "@ASSISTANT_NAME",
  "requiresTrigger": false
}' > /workspace/ipc/tasks/register_$(date +%s).json

mkdir -p /workspace/project/groups/main
```

**Additional chat** (trigger-only):

```bash
echo '{
  "type": "register_group",
  "jid": "tg:<chat-id>",
  "name": "<chat-name>",
  "folder": "<folder-name>",
  "trigger": "@ASSISTANT_NAME",
  "requiresTrigger": true
}' > /workspace/ipc/tasks/register_$(date +%s).json

mkdir -p /workspace/project/groups/<folder-name>
```

**Topic thread** — each topic gets its own agent with independent memory and context:

```bash
echo '{
  "type": "register_group",
  "jid": "tg:<chat-id>:<topic-id>",
  "name": "<topic-name>",
  "folder": "<topic-folder>",
  "trigger": "@ASSISTANT_NAME",
  "requiresTrigger": false
}' > /workspace/ipc/tasks/register_$(date +%s).json

mkdir -p /workspace/project/groups/<topic-folder>
```

**Topic with a project directory mounted:**

```bash
echo '{
  "type": "register_group",
  "jid": "tg:<chat-id>:<topic-id>",
  "name": "<topic-name>",
  "folder": "<topic-folder>",
  "trigger": "@ASSISTANT_NAME",
  "requiresTrigger": false,
  "containerConfig": {
    "additionalMounts": [
      {
        "hostPath": "~/projects/your-project",
        "containerPath": "your-project",
        "readonly": false
      }
    ]
  }
}' > /workspace/ipc/tasks/register_$(date +%s).json

mkdir -p /workspace/project/groups/<topic-folder>
```

> **Note on mounts:** The host path must already be in `~/.config/nanoclaw/mount-allowlist.json` on the host machine. This file lives outside the project root and must be edited manually — it cannot be modified from within a container. Ask the user to add the path before registering.

**Topic registration behavior:**

When a message arrives in a topic:
1. Check topic-specific registration (`tg:chatid:topicid`) → if registered, deliver to that agent
2. Check base chat registration (`tg:chatid`) → if registered, skip (prevents duplicate processing)
3. Neither registered → ignore message

Topics are opt-in: a registered base chat will not automatically process its topic messages.

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Telegram chat:
> - For main chat: Any message works
> - For non-main: `@Andy hello` or @mention the bot
> - For topics: Send a message in the registered topic thread
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

### Topic messages not being processed

1. Verify the topic is registered with the full JID (`tg:chatid:topicid`)
2. Ensure the base chat (`tg:chatid`) is NOT also registered
3. Check logs for: `Topic message in registered chat - topic not separately registered`

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
