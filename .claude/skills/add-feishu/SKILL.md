---
name: add-feishu
description: Add Feishu (Lark) as a channel. Can replace WhatsApp entirely or run alongside it. Uses WebSocket long-connection mode (no public IP needed). Triggers on "feishu", "飞书", "lark", "add feishu", "飞书机器人", "飞书频道".
---

# Add Feishu Channel

This skill adds Feishu (飞书/Lark) support to NanoClaw. It creates a new channel implementation using the `@larksuiteoapi/node-sdk` WebSocket long-connection mode, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `add-feishu` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Mode**: Replace WhatsApp or add alongside it?
   - Replace → will set `FEISHU_ONLY=true`
   - Alongside → both channels active (default)

2. **Do they already have a Feishu app configured?** If yes, collect the App ID and App Secret now. If no, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

### Install dependency

```bash
npm install @larksuiteoapi/node-sdk
```

Requires `@larksuiteoapi/node-sdk` >= 1.24.0 (for WSClient long-connection support).

### Create `src/channels/feishu.ts` — Feishu Channel

Implement the `Channel` interface from `src/types.ts`. Reference `src/channels/telegram.ts` for the pattern.

Implementation requirements:

**Constructor:**
- Accept `appId`, `appSecret`, and channel opts (`onMessage`, `onChatMetadata`, `registeredGroups`)
- Create `lark.Client` with `appType: lark.AppType.SelfBuild`, `domain: lark.Domain.Feishu`
- Create `lark.WSClient` with same credentials

**`connect()`:**
- Create `lark.EventDispatcher` and register `im.message.receive_v1` event handler
- In the event handler:
  - Extract `chat_id` from `data.message.chat_id`
  - Construct JID as `fs:{chat_id}` (following the `tg:{chat_id}` convention from Telegram)
  - Parse message content based on `message_type`:
    - `text` → `JSON.parse(data.message.content).text`
    - Other types → `[{message_type} 消息]` placeholder
  - Handle @bot mentions: check `data.message.mentions` for bot name, translate to trigger pattern (same approach as Telegram)
  - Call `opts.onChatMetadata(jid, timestamp, chatName, 'feishu', true)`
  - Call `opts.onMessage(jid, newMessage)` with a `NewMessage` object
- Start WebSocket: `await this.wsClient.start({ eventDispatcher: dispatcher })`

**`sendMessage(jid, text)`:**
- Extract chat_id: `jid.replace('fs:', '')`
- Handle long messages: split at 4000 chars (Feishu's limit)
- Call `client.im.message.create` with `receive_id_type: 'chat_id'`, `msg_type: 'text'`, `content: JSON.stringify({ text })`

**`ownsJid(jid)`:** Return `jid.startsWith('fs:')`

**`isConnected()`:** Return internal connected state

**`disconnect()`:** Set connected to false, log disconnection

**`setTyping()`:** No-op — Feishu Bot API does not expose a typing indicator

**Sender name resolution:**
- The `im.message.receive_v1` event does not include the sender's display name
- Use `data.message.sender.sender_id.open_id` as a fallback sender identifier
- Optionally call `client.contact.user.get` to resolve the display name (lazy, with cache)
- If name resolution is too complex for the initial implementation, use a placeholder like `'用户'`

### Create `src/channels/feishu.test.ts` — Unit tests

Write tests following `src/channels/telegram.test.ts` pattern:
- Mock `@larksuiteoapi/node-sdk` (Client, WSClient, EventDispatcher)
- Test message parsing (text, non-text types)
- Test @mention translation to trigger pattern
- Test `sendMessage` with long message splitting
- Test `ownsJid` for `fs:` prefix
- Test connection lifecycle

### Modify `src/config.ts` — Add Feishu config

Read the intent file `modify/src/config.ts.intent.md` for detailed invariants.

Add to the `readEnvFile` keys array:
```
'FEISHU_ONLY',
```

Add export:
```typescript
export const FEISHU_ONLY = (process.env.FEISHU_ONLY || envConfig.FEISHU_ONLY) === 'true';
```

**Note**: `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are NOT read here. They are read directly by FeishuChannel via `readEnvFile()` to keep secrets off the config module (same pattern as `SLACK_BOT_TOKEN` in `slack.ts`).

### Modify `src/index.ts` — Add Feishu channel

Read the intent file `modify/src/index.ts.intent.md` for detailed invariants.

Key changes:
1. **Imports**: Add `FeishuChannel` from `./channels/feishu.js`, add `FEISHU_ONLY` from `./config.js`
2. **Module state**: Add `let feishu: FeishuChannel | undefined`
3. **`main()` function**:
   - Read `FEISHU_APP_ID` and `FEISHU_APP_SECRET` via `readEnvFile()` to check if Feishu is configured
   - If configured: create `FeishuChannel`, call `connect()`, push to `channels` array
   - If `FEISHU_ONLY`: skip WhatsApp creation (same pattern as `SLACK_ONLY` / `TELEGRAM_ONLY`)
4. **Shutdown handler**: Already iterates `channels` array — no change needed if following the multi-channel pattern

### Update `.env.example`

Add:
```bash
# Feishu (飞书) channel
# FEISHU_APP_ID=cli_xxxxx
# FEISHU_APP_SECRET=xxxxx
# FEISHU_ONLY=false
```

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new feishu tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Feishu App (if needed)

If the user doesn't have a Feishu app, share these instructions:

> **创建飞书自建应用：**
>
> 1. 打开[飞书开放平台](https://open.feishu.cn/app)，登录后点击「创建自建应用」
> 2. 填写应用名称和描述，创建应用
> 3. 在应用详情页，添加「机器人」能力
> 4. 进入「权限管理」，添加以下权限：
>    - `im:message` — 读取消息
>    - `im:message:send_as_bot` — 以机器人身份发消息
>    - `im:message.group_at_msg` — 接收群内@消息
>    - `im:message.p2p_msg` — 接收私聊消息
> 5. 进入「事件与回调」→「事件配置」：
>    - 订阅方式选择「使用长连接接收事件」
>    - 添加事件：`im.message.receive_v1`（接收消息）
> 6. **重要**：必须先「发布应用」，长连接配置才能保存
> 7. 在「凭证与基础信息」页面复制 **App ID** 和 **App Secret**

Wait for the user to provide both credentials.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
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
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. 将机器人添加到一个飞书群（群设置 → 群机器人 → 添加机器人）
> 2. 在群里发一条消息@机器人
> 3. 查看 NanoClaw 日志，找到 `chat_id`：`tail -f logs/nanoclaw.log | grep 'fs:'`
> 4. 或者在飞书群的 URL 中获取群 ID
>
> JID 格式为：`fs:{chat_id}`

Wait for the user to provide the chat ID.

### Register the chat

Use the IPC register flow or register directly. The chat ID, name, and folder name are needed.

For a main chat (responds to all messages, uses the `main` folder):

```typescript
registerGroup("fs:<chat-id>", {
  name: "<chat-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("fs:<chat-id>", {
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

> 在已注册的飞书群中发一条消息：
> - 主群：直接发任意消息
> - 其他群：`@机器人名称 你好`
>
> 机器人应该在几秒内回复。

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i feishu
```

## Troubleshooting

### Bot not responding

1. Check `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'fs:%'"`
3. For non-main chats: message must include trigger pattern (@机器人名)
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Bot connected but not receiving messages

1. Verify the app has been published (长连接模式必须发布应用)
2. Verify event subscription is configured: 「事件与回调」→ 订阅方式为「长连接」→ 已添加 `im.message.receive_v1`
3. Verify the bot has been added to the group
4. Verify permissions are granted: `im:message`, `im:message:send_as_bot`, `im:message.group_at_msg`

### WebSocket connection fails

1. Check network connectivity to Feishu servers
2. Long-connection only supports 企业自建应用 (enterprise self-built apps), not marketplace apps
3. Each app supports maximum 50 concurrent connections
4. Check logs for connection errors: `tail -f logs/nanoclaw.log | grep -i 'ws\|websocket\|feishu'`

### Message sending fails

1. Verify `im:message:send_as_bot` permission is granted
2. Check if the bot is still a member of the group
3. Feishu API rate limit: 16 requests/second per app. If hitting limits, messages may be dropped.

### Getting chat ID

If chat ID is hard to find:
- Check NanoClaw logs after sending a message: `grep 'fs:' logs/nanoclaw.log`
- Via Feishu API: `curl -H "Authorization: Bearer {tenant_access_token}" "https://open.feishu.cn/open-apis/im/v1/chats"`

## After Setup

The Feishu channel supports:
- **Group chats** — Bot must be added to the group
- **Direct messages** — Users can DM the bot (requires `im:message.p2p_msg` permission)
- **Multi-channel** — Can run alongside WhatsApp/Telegram/Slack (default) or replace WhatsApp (`FEISHU_ONLY=true`)

## Known Limitations

- **Text only** — Only text messages are processed. Images, files, rich cards, and interactive elements are shown as `[{type} 消息]` placeholder. Full rich content handling requires additional message type parsers.
- **No typing indicator** — Feishu Bot API does not expose a typing indicator. `setTyping()` is a no-op.
- **Sender name not in event** — The `im.message.receive_v1` event doesn't include sender display name. Name resolution requires an extra API call (`contact.user.get`), which adds latency. Initial implementation may use `open_id` or a placeholder.
- **Long-connection limits** — Maximum 50 concurrent connections per app. Messages are delivered in cluster mode (not broadcast), meaning only one connection receives each message.
- **App must be published** — Long-connection mode requires the app to be published first. Draft/unpublished apps cannot use WebSocket event subscription.
- **Enterprise only** — Long-connection mode only works with enterprise self-built apps (企业自建应用), not marketplace apps or personal apps.
