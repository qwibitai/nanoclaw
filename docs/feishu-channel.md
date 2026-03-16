# Feishu Channel

飞书 (Feishu) messaging channel for NanoClaw.

## Setup

### 1. Create a Feishu App

Go to [Feishu Open Platform](https://open.feishu.cn/) and create a self-built app. Note the **App ID** and **App Secret**.

### 2. Configure Permissions

In the app's **Permissions Management**, enable:

| Scope | Purpose |
|-------|---------|
| `im:message:send_as_bot` | Send messages |
| `im:message.group_at_msg:readonly` | Receive @mentions in groups |
| `im:message.p2p_msg:readonly` | Receive direct messages |
| `contact:user.base:readonly` | Resolve sender display names |

### 3. Subscribe to Events

In **Events & Callbacks > Event Configuration**:

1. Select **Long Connection** mode (WebSocket, no public URL needed)
2. Add event: `im.message.receive_v1`
3. Publish a new version of the app

### 4. Configure NanoClaw

Add to `.env`:

```
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret
```

The channel auto-registers at startup. If credentials are missing, it is silently skipped.

### 5. Register a Group

Send a message in the target Feishu group (with the bot added). The chat will appear in discovery. Register it:

```bash
npx tsx setup/index.ts --step register -- --jid "feishu:oc_CHATID" --name "Group Name" --folder "group-folder" --trigger "@Andy"
```

The chat ID (`oc_...`) can be found in Feishu's group settings or from the bot's logs.

## Architecture

Same pattern as Telegram — single file, self-registration via factory:

```
src/channels/feishu.ts    # FeishuChannel class + registerChannel()
src/channels/feishu.test.ts  # 32 unit tests (fully mocked SDK)
```

### Connection

WebSocket long connection via `@larksuiteoapi/node-sdk`. Two SDK objects:

- `Lark.Client` — API calls (send messages, query users)
- `Lark.WSClient` — event subscription (receives messages)

Both are initialized in `connect()`. No public URL or webhook endpoint required.

### JID Format

```
feishu:{chat_id}
```

Example: `feishu:oc_abc123def456`. The `ownsJid()` method routes by `feishu:` prefix.

### Message Flow

**Inbound:**

```
Feishu → WSClient (im.message.receive_v1) → handleMessage()
  → emit onChatMetadata (always, for discovery)
  → filter: registered groups only
  → extract content (text / post / placeholders)
  → @mention → replace placeholder with @{ASSISTANT_NAME}
  → private chat → prepend @{ASSISTANT_NAME}
  → resolve sender name (API + cache)
  → onMessage() → SQLite → agent
```

**Outbound:**

```
agent response → sendMessage() → split at 4096 chars → im.v1.message.create()
```

### Non-Text Messages

| Type | Output |
|------|--------|
| `text` | Parsed text content |
| `post` | Extracted plain text (title + content segments) |
| `image` | `[Image]` |
| `file` | `[File]` |
| `audio` | `[Audio]` |
| `media` | `[Video]` |
| `sticker` | `[Sticker]` |
| other | `[Unsupported: {type}]` |

## Known Limitations

- **Bot identity API path** (`bot.v3.info.get()`) may vary by SDK version. Wrapped in try/catch — if it fails, @mention detection and `is_from_me` filtering degrade gracefully. Basic message send/receive still works.
- **Typing indicators** not supported by Feishu API. `setTyping()` is a noop.
- **Chat names** not included in message events. Admin UI may show unnamed chats until manually set.
- **Sender name cache** grows unboundedly. Acceptable for personal use; not designed for high-user-count scenarios.
