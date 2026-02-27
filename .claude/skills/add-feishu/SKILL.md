---
name: add-feishu
description: Add Feishu (Lark) as a channel for NanoClaw. Supports both group chats and private messages via WebSocket long connection.
---

# Add Feishu Channel

This skill adds Feishu (Lark) support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Mode**: Replace WhatsApp or add alongside it?
   - Replace → will set `FEISHU_ONLY=true`
   - Alongside → both channels active (default)

2. **Do they already have a Feishu app?** If yes, collect App ID and App Secret now. If no, we'll create one in Phase 3.

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
npx tsx scripts/apply-skill.ts .claude/skills/add-feishu
```

This deterministically:
- Adds `src/channels/feishu.ts` (FeishuChannel class implementing Channel interface)
- Adds `src/channels/feishu.test.ts` (unit tests)
- Three-way merges Feishu support into `src/index.ts` (multi-channel support, findChannel routing)
- Three-way merges Feishu config into `src/config.ts` (FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_ONLY exports)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Updates `.env.example` with `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and `FEISHU_ONLY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new feishu tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Feishu App (if needed)

If the user doesn't have a Feishu app, tell them:

> I need you to create a Feishu app:
>
> 1. Go to https://open.feishu.cn/app
> 2. Click **创建企业自建应用** (Create Enterprise Self-built App)
> 3. Fill in app name, description, and icon
> 4. Go to **凭证与基础信息** (Credentials & Basic Info) to get App ID and App Secret
> 5. Go to **应用能力** > **添加应用能力** > Add **机器人** (Bot) capability
> 6. Go to **权限管理** and add these permissions:
>    - `im:message.p2p_msg:readonly` - Read user private chat messages
>    - `im:message.group_at_msg:readonly` - Receive group @ mentions
>    - `im:message:send_as_bot` - Send messages as bot
>    - `im:chat:read` - Read chat info
> 7. Go to **事件与回调** > **订阅方式** and select **使用长连接接收事件** (Long connection)
> 8. Go to **事件配置** and add `im.message.receive_v1` event
> 9. Go to **版本管理与发布** and create a test version

Wait for the user to provide the App ID (format: `cli_xxxxxxxxxxxxxxxx`) and App Secret.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=<their-app-id>
FEISHU_APP_SECRET=<their-app-secret>
```

If they chose to replace WhatsApp:

```bash
FEISHU_ONLY=true
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Get Chat ID

The user needs to send a message to get the chat ID. Tell them:

> 1. Add the bot to your group chat, or send a private message to the bot
> 2. Send any message (e.g., "hello")
> 3. Check the logs to find the chat ID

Wait for the user to send a message, then look at the logs:

```bash
tail -f logs/nanoclaw.log | grep "chatJid"
```

The chat ID will look like `feishu:oc_xxxxxxxxxxxxxxxx` (group) or `feishu:oc_xxxxxxxxxxxxxxxx` (private).

### Register the chat

Use the IPC register flow or register directly. The chat ID, name, and folder name are needed.

For a main chat (responds to all messages, uses the `main` folder):

```typescript
registerGroup("feishu:<chat-id>", {
  name: "<chat-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("feishu:<chat-id>", {
  name: "<chat-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Feishu chat:
> - For main chat: Any message works
> - For non-main: `@Andy hello` or mention the bot
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'feishu:%'"`
3. For non-main chats: message must include trigger pattern
4. Service is running: `launchctl list | grep nanoclaw`
5. Check Feishu app permissions are enabled and app is published

### WebSocket connection errors
...
### Container Deadlock (Typing indicator not removed)

If the Feishu bot hangs with "Typing..." and never responds:
1. Ensure `isOneShot: true` is being passed to `runContainerAgent` for non-streaming queries.
2. Check that `runAgent` always passes a callback to `runContainerAgent` to enable stdout marker parsing.
3. Verify the container's `agent-runner` is updated to handle the `isOneShot` flag.

### Getting chat ID

If the chat ID doesn't appear in logs:
- Verify the bot is in the group (for group chats)
- Send a direct message to the bot (for private chats)
- Check `logs/nanoclaw.log` for `Feishu: chat JID info` entries

## After Setup

The Feishu channel supports:
- Group chat messages (using `chat_id`)
- Private chat messages (using `chat_id`)
- Text messages
- Post/rich text messages
- Auto-reply to registered chats

No additional setup is required.
