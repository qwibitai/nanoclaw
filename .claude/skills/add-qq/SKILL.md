---
name: add-qq
description: Add QQ as a channel. Supports private chat (C2C) and group chat. Uses WebSocket for real-time messaging and QQ Bot API for message sending.
---

# Add QQ Channel

This skill adds QQ bot support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `qq` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have QQ Bot credentials (appId and clientSecret), or do you need to create one?

If they have one, collect them now. If not, we'll create one in Phase 3.

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
npx tsx scripts/apply-skill.ts .claude/skills/add-qq
```

This deterministically:
- Adds `src/channels/qq.ts` (QQChannel class with self-registration via `registerChannel`)
- Adds `import './qq.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `ws` npm dependency
- Updates `.env.example` with `QQBOT_APP_ID` and `QQBOT_CLIENT_SECRET`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup

### Create QQ Bot (if needed)

If the user doesn't have bot credentials, tell them:

> I need you to create a QQ Bot:
>
> 1. Go to [QQ Open Platform](https://q.qq.com/) and log in
> 2. Create a bot application and get the `appId` and `clientSecret`
> 3. Enable the bot and configure the intents you need:
>    - For private chat: Enable C2C message receiving
>    - For group chat: Enable group message receiving (requires approval)
> 4. Copy the `appId` and `clientSecret`

Wait for the user to provide the credentials.

### Configure environment

Add to `.env`:

```bash
QQBOT_APP_ID=<your-app-id>
QQBOT_CLIENT_SECRET=<your-client-secret>
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Send a message to your QQ bot
> 2. Check the logs for the chat ID format:
>    - Private chat: `qq:<openid>`
>    - Group chat: `qq:group:<groupid>`

For groups, the bot needs to be added to the group first.

Wait for the user to provide the chat ID.

### Register the chat

Use the IPC register flow or register directly. The chat ID, name, and folder name are needed.

For a main chat (responds to all messages):

```typescript
registerGroup("qq:<openid>", {
  name: "<chat-name>",
  folder: "qq_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For group chats:

```typescript
registerGroup("qq:group:<groupid>", {
  name: "<group-name>",
  folder: "qq_<group-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered QQ chat:
> - For main chat: Any message works
> - For group chat: @mention the bot
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `QQBOT_APP_ID` and `QQBOT_CLIENT_SECRET` are set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite (check with: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'qq:%'"`)
3. For non-main chats: message includes trigger pattern
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### WebSocket connection issues

1. Check logs for connection errors
2. Verify credentials are correct
3. Check if the bot is approved for the required intents

### Getting chat ID

Send any message to the bot and check logs:
```bash
tail -f logs/nanoclaw.log | grep "QQ message"
```

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

## Removal

To remove QQ integration:

1. Delete `src/channels/qq.ts`
2. Remove `import './qq.js'` from `src/channels/index.ts`
3. Remove `QQBOT_APP_ID` and `QQBOT_CLIENT_SECRET` from `.env`
4. Remove QQ registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'qq:%'"`
5. Uninstall: `npm uninstall ws @types/ws`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
