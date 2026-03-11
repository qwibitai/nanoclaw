# Feishu Channel

**Date:** 2026-03-11
**Status:** Draft
**Branch:** `feat/feishu-channel`
**Reference:** `feature/network-environment-customization`

## Problem

NanoClaw supports WhatsApp, Telegram, Slack, Discord, and Gmail, but not Feishu (飞书) / Lark — the dominant enterprise messaging platform in China. Adding Feishu enables Chinese users and teams to use NanoClaw through their primary communication tool.

## Goal

Add Feishu as a first-class channel, following the same patterns as Slack and Discord (built into core, activated by env vars). Support both Feishu (China, `open.feishu.cn`) and Lark (International, `open.larksuite.com`) via a single env var.

## Approach

**Direct port from `feature/network-environment-customization`.**

The reference branch contains a complete, validated Feishu implementation (`src/channels/feishu.ts`) and a setup skill (`.claude/skills/add-feishu/SKILL.md`). The work is to port these into `main`, wire up registration, add the npm dependency, and update `.env.example`.

---

## Architecture

### How it fits into NanoClaw

Feishu follows the same channel pattern as Slack and Discord:

- `src/channels/feishu.ts` exports a factory function that calls `registerChannel('feishu', factory)` at module load
- `src/channels/index.ts` imports `'./feishu.js'` to trigger registration
- At startup, `src/index.ts` iterates registered channels, calls each factory, and skips channels whose factory returns `null` (missing credentials)
- Inbound messages arrive via the Feishu WebSocket SDK, are parsed into `NewMessage` objects, and handed to `opts.onMessage()`
- Outbound messages are routed via `findChannel(channels, jid)` → `channel.sendMessage(jid, text)`

### Message flow

```
INBOUND:
  Feishu WebSocket event (im.message.receive_v1)
    → handleMessage(): filter own messages, parse JSON text, build NewMessage
    → opts.onMessage(chatJid, msg)           // chatJid = "<chat_id>@feishu"
    → src/index.ts stores in SQLite
    → main loop: trigger check → container agent

OUTBOUND:
  Agent output text
    → src/router.ts: strip <internal> tags, prefix with assistant name
    → findChannel(channels, jid) → FeishuChannel
    → sendMessage(): im.v1.message.create() with JSON-encoded text
    → Feishu chat
```

---

## File Changes

### New: `src/channels/feishu.ts`

Full channel implementation. Key details:

**Class:** `FeishuChannel implements Channel`

**Fields:**
- `name = 'feishu'`
- `client: lark.Client` — for API calls (send messages, fetch bot info)
- `wsClient: lark.WSClient` — for receiving events via WebSocket
- `botOpenId: string` — fetched on connect, used to filter own messages
- `appId`, `appSecret` — from `.env` via `readEnvFile()`
- `platform` — `'feishu'` or `'lark'`, controls SDK domain

**`connect()` sequence:**
1. Read `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_PLATFORM` from `.env`
2. Initialise `lark.Client({ appId, appSecret, domain })` where domain is `lark.Domain.Feishu` or `lark.Domain.Lark`
3. Fetch `/bot/v3/info` to get own `open_id` → stored as `botOpenId`
4. Create `lark.WSClient` and `EventDispatcher` subscribed to `im.message.receive_v1`
5. Call `wsClient.start({ eventDispatcher })` — SDK manages reconnection
6. Set `connected = true`

**`handleMessage(data)` logic:**
1. Extract `message` and `sender` from event payload
2. Skip if `sender.sender_id.open_id === botOpenId` (own message)
3. Skip if `msg.message_type !== 'text'`
4. Parse `JSON.parse(msg.content).text` for message body
5. Build `chatJid = msg.chat_id + '@feishu'`
6. Call `opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup)`
7. If `opts.registeredGroups()[chatJid]` exists → call `opts.onMessage(chatJid, newMessage)`

**`sendMessage(jid, text)` logic:**
1. Strip `@feishu` suffix to get raw `chat_id`
2. Call `this.client.im.v1.message.create()` with:
   - `receive_id_type: 'chat_id'`
   - `receive_id: chatId`
   - `msg_type: 'text'`
   - `content: JSON.stringify({ text })`

**`ownsJid(jid)`:** returns `jid.endsWith('@feishu')`

**Factory:**
```typescript
export function createFeishuChannel(opts: ChannelOpts): Channel | null {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) return null;
  return new FeishuChannel(opts);
}
registerChannel('feishu', createFeishuChannel);
```

---

### Modified: `src/channels/index.ts`

Add one import line:

```typescript
import './feishu.js';
```

---

### Modified: `package.json`

Add dependency:

```json
"@larksuiteoapi/node-sdk": "^1.59.0"
```

---

### Modified: `.env.example`

```env
# Feishu / Lark channel
FEISHU_APP_ID=
FEISHU_APP_SECRET=
# FEISHU_PLATFORM=feishu   # 'feishu' (China, default) or 'lark' (International)
```

---

### New: `.claude/skills/add-feishu/SKILL.md`

Setup skill with 5 phases:

**Phase 1 — Pre-flight**
- Check if `FEISHU_APP_ID` already set in `.env`
- Ask: Feishu (China, `open.feishu.cn`) or Lark (International, `open.larksuite.com`)?

**Phase 2 — Create app**
- Open developer portal:
  - Feishu: https://open.feishu.cn/app
  - Lark: https://open.larksuite.com/app
- Create custom app → enable Bot feature
- Required permissions:
  - `im:message:read_basic` — read messages
  - `im:message.receive_v1` — receive message events
  - `im:message:send_basic` — send messages
- Event subscriptions → add `im.message.receive_v1`
- Connection mode → **WebSocket (Long Connection)** (not webhook URL)
- Publish the app version

**Phase 3 — Apply credentials**
- Collect App ID and App Secret from app credentials page
- Write to `.env`:
  ```
  FEISHU_APP_ID=cli_xxxxxxxxxxxxx
  FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  FEISHU_PLATFORM=feishu   # or lark
  ```
- Run `npm install && npm run build`

**Phase 4 — Register a chat**
- Ask: group chat or direct message?
- For group: add the bot to the group, copy the chat ID (format: `oc_xxxxxx`)
- Construct JID: `<chat_id>@feishu`
- Run registration (same as other channels):
  ```
  npx tsx src/cli.ts register --jid "oc_abc123@feishu" --name "my-group"
  ```

**Phase 5 — Verify**
- Restart the service
- Send a message to the chat (include trigger word if non-main group)
- Check logs: `tail -f logs/nanoclaw.log`
- Expected: agent response in Feishu chat within a few seconds

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `FEISHU_APP_ID` | Yes | — | App ID from Feishu/Lark developer portal |
| `FEISHU_APP_SECRET` | Yes | — | App Secret (sensitive) |
| `FEISHU_PLATFORM` | No | `feishu` | `feishu` for China, `lark` for International |

---

## Feishu API Reference

| Aspect | Detail |
|---|---|
| **Event delivery** | WebSocket (Long Connection) — no public URL needed |
| **SDK** | `@larksuiteoapi/node-sdk` — `Client`, `WSClient`, `EventDispatcher` |
| **Event type** | `im.message.receive_v1` |
| **Message format** | JSON-encoded: `{ "text": "..." }` |
| **Chat ID format** | `oc_xxxxxx` (group), `ou_xxxxxx` (DM) |
| **User ID format** | `open_id` — per-app unique user identifier |
| **Bot identity** | Fetched via `GET /bot/v3/info` → `bot.open_id` |
| **Send API** | `im.v1.message.create()` with `receive_id_type: chat_id` |
| **Domains** | Feishu: `open.feishu.cn`, Lark: `open.larksuite.com` |

---

## Out of Scope

- Rich message types (cards, images, files) — text only for now
- Reaction support
- Mention/at parsing
- Thread replies
- Network routing (claude-code-router) — separate concern
