---
name: add-feishu
description: Add Feishu (Lark) as a channel. Uses WebSocket long connection mode (no public URL needed). Supports group chats and direct messages.
---

# Add Feishu Channel

This skill adds Feishu (飞书) support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Feishu app with App ID and App Secret, or do you need to create one?

If they have credentials, collect them now. If not, we'll create the app in Phase 3.

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
- Adds `src/channels/feishu.ts` (FeishuChannel class with self-registration via `registerChannel`)
- Adds `src/channels/feishu.test.ts` (comprehensive unit tests)
- Appends `import './feishu.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Updates `.env.example` with `FEISHU_APP_ID` and `FEISHU_APP_SECRET`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new feishu tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Feishu App (if needed)

If the user doesn't have a Feishu app, tell them:

> I need you to create a Feishu enterprise custom app (企业自建应用):
>
> 1. Open https://open.feishu.cn/app and log in
> 2. Click **Create Custom App** (创建企业自建应用)
> 3. Fill in app name (e.g., "Andy Assistant") and description
> 4. After creation, go to **Credentials & Basic Info** (凭证与基本信息)
> 5. Copy the **App ID** and **App Secret**
>
> Then add the bot capability:
>
> 6. Go to **Add Capabilities** (添加应用能力) → Enable **Bot** (机器人)
>
> Configure permissions (batch import):
>
> 7. Go to **Permissions & Scopes** (权限管理) → **Batch toggle** (批量开通) → paste this JSON:
>    ```json
>    {
>      "scopes": {
>        "tenant": [
>          "im:message",
>          "im:message:send_as_bot",
>          "im:chat:readonly",
>          "contact:user.base:readonly",
>          "contact:contact.base:readonly"
>        ]
>      }
>    }
>    ```
>
> Publish the app (required before the bot can function):
>
> 8. Go to **Version Management** (版本管理与发布) → **Create Version** → **Submit for Review**
> 9. An admin must approve the app in the Feishu Admin Console (管理后台)
> 10. Wait for approval before proceeding
>
> **Note**: Every time you change permissions or event subscriptions, you must create a new version and get it approved again for the changes to take effect.

Wait for the user to provide the App ID and App Secret, then configure `.env` and start the service (see below).

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=<their-app-id>
FEISHU_APP_SECRET=<their-app-secret>
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and start the service

```bash
npm run build
npm run dev  # or restart via launchctl/systemctl
```

### Configure event subscription (requires running service)

The event subscription must be saved while the service is running, because Feishu verifies the WebSocket connection on save.

Tell the user:

> Now go back to the Feishu open platform:
>
> 1. Go to **Event Subscriptions** (事件订阅)
> 2. Choose **WebSocket Mode** (使用长连接接收事件)
> 3. Add event: `im.message.receive_v1` (Receive messages)
> 4. Click **Save** — the console will detect the active WebSocket connection
>
> After saving, create a new app version and get it approved again for the event subscription to take effect.

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Open your Feishu bot in a direct message (search for the bot name)
> 2. Send `/chatid` — it will reply with the chat ID
> 3. For groups: add the bot to the group first, then send `/chatid` in the group

Wait for the user to provide the chat ID (format: `feishu:oc_xxxxxxxxxxxxxxxx`).

### Register the chat

Use the IPC register flow or register directly. The chat ID, name, and folder name are needed.

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
> - For non-main: @mention the bot in the group
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

Look for `Feishu bot connected` and `Feishu message stored` entries.

## Features

### Markdown Support

The Feishu channel uses Feishu's native `md` tag in post format, which delegates Markdown rendering to the server. This provides full Markdown support with native styling:

| Markdown | Rendering |
|----------|-----------|
| `# Heading` | Native heading |
| `**bold**` / `__bold__` | Bold |
| `*italic*` / `_italic_` | Italic |
| `~~strikethrough~~` | Strikethrough |
| `<u>underline</u>` | Underline |
| `` `code` `` | Inline code |
| ` ``` ` code blocks | Syntax-highlighted code |
| `[text](url)` | Hyperlink |
| `> quote` | Block quote |
| `- item` / `1. item` | Lists |

Plain text messages without Markdown are sent as simple text messages for efficiency.

**Note:** The `md` tag is send-only. When reading back messages, Feishu returns the content as expanded post tags (`text`, `a`, etc.).

## Troubleshooting

### Bot not responding

Check:
1. `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'feishu:%'"`
3. For non-main chats: message includes trigger pattern (@mention the bot)
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)
5. App is published and approved in Feishu admin console

### Bot can't see messages

- Verify the app has the correct permissions (`im:message` for reading messages)
- Verify the event subscription `im.message.receive_v1` is configured with WebSocket mode
- Check that the bot is added to the group
- Make sure you created a new app version and got it approved after changing permissions or event subscriptions

### Sender names show as open_id instead of real names

- The app needs `contact:contact.base:readonly` permission (not just `contact:user.base:readonly`)
- Create a new app version and get it approved after adding the permission

### WebSocket connection fails

- Verify App ID and App Secret are correct
- Check network connectivity to `open.feishu.cn`
- Check logs for connection errors: `grep -i feishu logs/nanoclaw.log`

### Getting chat ID

If `/chatid` doesn't work:
- Make sure the app is published and approved
- Try sending `/ping` first to verify the bot is receiving messages
- Check logs for incoming message events

## Removal

To remove Feishu integration:

1. Delete `src/channels/feishu.ts` and `src/channels/feishu.test.ts`
2. Remove `import './feishu.js'` from `src/channels/index.ts`
3. Remove `FEISHU_APP_ID` and `FEISHU_APP_SECRET` from `.env`
4. Remove Feishu registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'feishu:%'"`
5. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
