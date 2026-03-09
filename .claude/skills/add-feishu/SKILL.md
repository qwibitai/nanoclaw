---
name: add-feishu
description: Add Feishu (飞书) as a channel. Uses WebSocket long connection mode - no public IP or domain required. Works alongside other channels like WhatsApp, Telegram, and Slack.
---

# Add Feishu Channel

This skill adds Feishu (飞书/Lark) support to NanoClaw using the official SDK with WebSocket long connection mode.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Feishu bot app created, or do you need to create one?

If they have one, collect App ID and App Secret. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-feishu
```

This deterministically:
- Adds `src/channels/feishu.ts` (FeishuChannel class with self-registration)
- Adds `src/channels/feishu.test.ts` (unit tests)
- Appends `import './feishu.js'` to `src/channels/index.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Updates `.env.example` with Feishu credentials
- Records the application in `.nanoclaw/state.yaml`

### Validate code changes

```bash
npm test
npm run build
```

## Phase 3: Setup

### Create Feishu Bot App (if needed)

If the user doesn't have a bot app, tell them:

> I need you to create a Feishu bot app:
>
> 1. Go to [Feishu Open Platform](https://open.feishu.cn/app)
> 2. Click "创建企业自建应用" (Create Enterprise Self-built App)
> 3. Fill in:
>    - App name: Something friendly (e.g., "NanoClaw Assistant")
>    - App description: Brief description
> 4. After creation, go to "凭证与基础信息" (Credentials & Basic Info)
> 5. Copy **App ID** and **App Secret**

Wait for the user to provide the credentials.

### Configure App Permissions

Tell the user:

> Configure the bot permissions:
>
> 1. Go to "权限管理" (Permission Management)
> 2. Search and enable these permissions:
>    - `im:message` - 获取与发送消息
>    - `im:message:send_as_bot` - 以应用身份发消息
>    - `im:chat` - 获取群组信息
>    - `im:chat:readonly` - 读取群组信息
> 3. Go to "事件订阅" (Event Subscription)
>    - Enable "接收消息" (Receive Message) events:
>      - `im.message.receive_v1` - 接收消息

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=<your-app-id>
FEISHU_APP_SECRET=<your-app-secret>
FEISHU_ENCRYPT_KEY=<your-encrypt-key>  # Optional, for encrypted push
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> To get the chat ID for registration:
>
> 1. Add your bot to a Feishu group chat (or open a direct message with the bot)
> 2. Send a message to the bot/group
> 3. Check the logs for the chat ID:
>
> ```bash
> tail -f logs/nanoclaw.log | grep "Feishu"
> ```
>
> The chat ID format is: `feishu:<chat_id>`

Wait for the user to provide the chat ID.

### Register the chat

Use the IPC register flow or register directly.

For a main chat (responds to all messages):

```typescript
registerGroup("feishu:<chat-id>", {
  name: "<chat-name>",
  folder: "feishu_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("feishu:<chat-id>", {
  name: "<chat-name>",
  folder: "feishu_<group-name>",
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
> - For non-main: @mention the bot or use the trigger pattern
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Architecture Notes

### WebSocket Long Connection Mode

Feishu channel uses WebSocket long connection mode instead of Webhook:

- **No public IP required**: Works in local development environment
- **No port forwarding**: No need for ngrok or similar tools
- **Simplified setup**: Just provide App ID and App Secret
- **Auto-reconnect**: SDK handles reconnection automatically

### JID Format

- Chat ID: `feishu:<chat_id>`
- Example: `feishu:oc_xxxxxxxxxxxxxxxx`

### Message Types Supported

- Text messages
- Images (placeholder)
- Files (placeholder)
- Audio/Voice (placeholder)

## Troubleshooting

### Bot not responding

Check:
1. `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'feishu:%'"`
3. Permissions are enabled in Feishu admin console
4. Event subscription is enabled
5. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Connection errors

1. Check network connectivity to `ws://open.feishu.cn`
2. Verify App ID and App Secret are correct
3. Check logs for specific error messages

### Getting chat ID

If you can't find the chat ID in logs:
1. Make sure the bot has received at least one message
2. Check that the chat is not filtered by `registeredGroups` check

## Removal

To remove Feishu integration:

1. Delete `src/channels/feishu.ts` and `src/channels/feishu.test.ts`
2. Remove `import './feishu.js'` from `src/channels/index.ts`
3. Remove Feishu credentials from `.env`
4. Remove Feishu registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'feishu:%'"`
5. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
