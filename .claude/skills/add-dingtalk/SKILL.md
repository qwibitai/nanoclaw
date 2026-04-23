---
name: add-dingtalk
description: Add DingTalk as a channel using Stream Mode. Supports receiving and sending messages in individual and group conversations.
---

# Add DingTalk Channel

This skill adds DingTalk (钉钉) support to NanoClaw using the official Stream Mode SDK, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `dingtalk` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have DingTalk app credentials (Client ID and Secret), or do you need to create them?

If they have them, collect them now. If not, we'll create them in Phase 3.

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
npx tsx scripts/apply-skill.ts .claude/skills/add-dingtalk
```

This deterministically:
- Adds `src/channels/dingtalk.ts` (DingTalkChannel class with self-registration via `registerChannel`)
- Adds `src/channels/dingtalk.test.ts` (unit tests)
- Appends `import './dingtalk.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `dingtalk-stream` npm dependency
- Updates `.env.example` with `DINGTALK_CLIENT_ID` and `DINGTALK_CLIENT_SECRET`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new dingtalk tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create DingTalk App (if needed)

If the user doesn't have credentials, tell them:

> I need you to create a DingTalk enterprise internal app:
>
> 1. Go to [DingTalk Developer Console](https://open-dev.dingtalk.com/)
> 2. Create a new "Enterprise Internal App" (企业内部应用)
> 3. Go to "Application Capabilities" > "Add Capability" > "Bot"
> 4. Fill in bot information and select **Stream Mode**
> 5. Publish the app
> 6. Copy the Client ID (AppKey) and Client Secret (AppSecret)

Wait for the user to provide the credentials.

### Configure environment

Add to `.env`:

```bash
DINGTALK_CLIENT_ID=ding7kjnoaiur7ofnm23
DINGTALK_CLIENT_SECRET=t1TUUUiYEZf7qijl2XSaKuFa3H6ffEgOuHJEb4i9qVRqvNSnXNJaD8FQECcHVQel
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Add bot to conversations

Tell the user:

> To use the bot:
> 1. In DingTalk, find your app in the "Apps" section
> 2. Start a conversation with the bot (for direct messages)
> 3. For groups: Add the bot to the group chat
>
> The bot will receive messages from any conversation it's added to, once registered.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Conversation ID

Tell the user:

> 1. Send `/chatid` to the bot in any DingTalk conversation
> 2. The bot will reply with the conversation ID (format: `dingtalk:xxxx`)

Wait for the user to provide the conversation ID.

### Self-Registration (Recommended)

Users can self-register groups directly from the chat:

```
/register 名称|文件夹|触发器
```

Example: `/register 我的群|my_group|@Andy`

The bot will:
1. Validate the inputs
2. Create the group folder with CLAUDE.md
3. Register the group in the database
4. Enable the bot for the group (no trigger required)

### Register the conversation (Manual Method)

Use the IPC register flow or register directly. The conversation ID and folder name are needed.

For a main conversation (responds to all messages):

```typescript
registerGroup("dingtalk:<conversation-id>", {
  name: "<conversation-name>",
  folder: "dingtalk_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional conversations (trigger-only):

```typescript
registerGroup("dingtalk:<conversation-id>", {
  name: "<conversation-name>",
  folder: "dingtalk_<conversation-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Available Commands

The DingTalk bot supports the following commands (work even for unregistered groups):

| Command | Description | Works Unregistered |
|---------|-------------|-------------------|
| `/chatid` or `！chatid` | Show conversation ID and registration status | ✅ |
| `/register` or `！register` | Show registration help | ✅ |
| `/register 名称\|文件夹\|触发器` | Self-register the group | ✅ |
| `/ping` or `！ping` | Check if bot is online | ✅ |

Commands for registered groups only:

| Command | Description |
|---------|-------------|
| `/set-main` or `！设置主群` | Set current group as main (requires confirmation) |
| `/set-main-confirm` or `！确认设置主群` | Confirm setting as main group |
| `/unset-main` or `！取消主群` | Remove main group status (requires confirmation) |
| `/unset-main-confirm` or `！确认取消主群` | Confirm removing main status |
| `/cancel` or `！取消` | Cancel pending operation |

**Main Group Features:**
- Can see tasks from all groups
- Can manage other groups
- No trigger required for any message

**Confirmation Flow:**
Destructive operations (`/set-main`, `/unset-main`) require confirmation. The confirmation must be sent within 60 seconds.

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered DingTalk conversation:
> - For main conversation: Any message works
> - For non-main: `@Andy hello` (or your assistant's name)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `DINGTALK_CLIENT_ID` and `DINGTALK_CLIENT_SECRET` are set in `.env` AND synced to `data/env/env`
2. Conversation is registered in SQLite (check with: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'dingtalk:%'"`)
3. For non-main conversations: message includes trigger pattern
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)
5. Bot is added to the conversation in DingTalk

### Stream connection issues

The DingTalk Stream SDK uses WebSocket. Check:
1. Network connectivity to DingTalk servers
2. Credentials are correct (Client ID and Secret)
3. Bot is published in DingTalk Developer Console

### Getting conversation ID

If `/chatid` doesn't work:
- Verify the bot is added to the conversation
- Check logs for any connection errors
- Ensure the service is running

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

## Message Format Notes

DingTalk supports various message types. This implementation handles:
- **Text messages** - Full support
- **Other types** - Placeholder messages (`[Image]`, `[File]`, etc.)

The bot can send text messages. Rich content (cards, markdown) can be added in future enhancements.

## Removal

To remove DingTalk integration:

1. Delete `src/channels/dingtalk.ts` and `src/channels/dingtalk.test.ts`
2. Remove `import './dingtalk.js'` from `src/channels/index.ts`
3. Remove `DINGTALK_CLIENT_ID` and `DINGTALK_CLIENT_SECRET` from `.env`
4. Remove DingTalk registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'dingtalk:%'"`
5. Uninstall: `npm uninstall dingtalk-stream`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
