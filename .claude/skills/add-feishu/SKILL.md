---
name: add-feishu
description: Add Feishu (飞书) as a channel. Can replace other channels entirely or run alongside them. Uses WebSocket long connection for receiving messages.
---

# Add Feishu Channel

This skill adds Feishu (飞书) support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/feishu.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

## Phase 2: Apply Code Changes

The Feishu channel is already included in the codebase. Ensure the dependency is installed:

```bash
npm install @larksuiteoapi/node-sdk
npm run build
```

Verify `src/channels/feishu.ts` exists and `src/channels/index.ts` includes `import './feishu.js'`.

## Phase 3: Setup

### Create Feishu App (if needed)

If the user doesn't have a Feishu app, tell them:

> I need you to create a Feishu custom app:
>
> 1. Go to [飞书开放平台](https://open.feishu.cn/app) and log in
> 2. Click **创建企业自建应用**
> 3. Set a name (e.g., "NanoClaw Assistant")
> 4. Under **添加应用能力**, enable **机器人**
> 5. Under **权限管理**, grant these scopes:
>    - `im:message` (获取与发送单聊、群组消息)
>    - `im:message.group_at_msg` (接收群聊中@机器人消息事件)
>    - `im:message.group_at_msg:readonly` (获取群组中所有消息)
>    - `im:message.p2p_msg` (获取用户发给机器人的单聊消息)
>    - `im:message:send_as_bot` (以应用的身份发消息)
>    - `im:chat` (获取群组信息)
>    - `im:message.reactions` (消息表情回复)
>    - `im:resource` (获取消息中的资源文件, optional)
> 6. Under **事件订阅**, enable WebSocket mode (长连接)
> 7. Subscribe to event: `im.message.receive_v1`
> 8. Publish the app version and get admin approval
> 9. Copy the **App ID** and **App Secret** from 凭证与基础信息

Wait for the user to provide the App ID and App Secret.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
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

> 1. Add the bot to a Feishu group
> 2. The group chat_id looks like `oc_xxxxx` — you can find it in the group settings URL or via the Feishu API
> 3. For private chats, the chat_id is the user's `ou_xxxxx`

Wait for the user to provide the chat ID.

### Register the chat

For a main chat (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "fs:<chat-id>" --name "<chat-name>" --folder "feishu_main" --trigger "@${ASSISTANT_NAME}" --channel feishu --no-trigger-required --is-main
```

For additional group chats (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "fs:<chat-id>" --name "<chat-name>" --folder "feishu_<group-name>" --trigger "@${ASSISTANT_NAME}" --channel feishu
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in the registered Feishu chat:
> - For main chat: Any message works
> - For non-main: @mention the bot (e.g., @Andy hello)
>
> The bot should respond within a few seconds. You'll see an emoji reaction (OnIt) while it's processing.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'fs:%'"`
3. App is published and approved on 飞书开放平台
4. WebSocket mode is enabled (not webhook)
5. Event subscription `im.message.receive_v1` is configured
6. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Bot only sees @mentions

This is normal for non-main group chats (trigger-required). To make the bot respond to all messages, register with `--no-trigger-required`.

## Removal

1. Delete `src/channels/feishu.ts` and `src/channels/feishu.test.ts`
2. Remove `import './feishu.js'` from `src/channels/index.ts`
3. Remove `FEISHU_APP_ID` and `FEISHU_APP_SECRET` from `.env`
4. Remove Feishu registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'fs:%'"`
5. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
