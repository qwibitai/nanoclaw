---
name: add-feishu
description: Add Feishu (飞书) or Lark as a channel. Supports both Feishu (China, open.feishu.cn) and Lark (International, open.larksuite.com). Uses WebSocket event subscription — no public URL required.
---

# Add Feishu / Lark Channel

## Phase 1: Pre-flight

Check if Feishu is already configured:

```bash
grep -q "FEISHU_APP_ID" .env 2>/dev/null && echo "Already configured" || echo "Not configured"
```

If already configured, skip to Phase 4.

Ask the user: **Which platform?**
- **Feishu (飞书, China)** — `open.feishu.cn`
- **Lark (International)** — `open.larksuite.com`

## Phase 2: Create the Feishu/Lark App

Tell the user:

> **Step 1 — Open the developer portal:**
> - Feishu: https://open.feishu.cn/app
> - Lark: https://open.larksuite.com/app
>
> **Step 2 — Create a custom app:**
> - Click **创建企业自建应用** (Create Custom App)
> - Name it (e.g. "NanoClaw Assistant")
>
> **Step 3 — Enable the Bot feature:**
> - Go to **应用功能 → 机器人** and enable it
>
> **Step 4 — Add permissions** (权限管理):
> - `im:message:read_basic` — read messages
> - `im:message.receive_v1` — receive message events
> - `im:message:send_basic` — send messages
>
> **Step 5 — Subscribe to events** (事件订阅):
> - Add event: `im.message.receive_v1`
> - Set connection mode to **长连接 (WebSocket / Long Connection)**
>   *(No public URL needed — NanoClaw connects outbound)*
>
> **Step 6 — Publish a version** and wait for approval (enterprise) or self-approve (personal)

Ask: **Do you have your App ID and App Secret ready?**

Collect:
- App ID (e.g. `cli_xxxxxxxxxx`)
- App Secret (sensitive)

## Phase 3: Write credentials to .env

```bash
cat >> .env << 'EOF'

# Feishu / Lark channel
FEISHU_APP_ID=<app-id>
FEISHU_APP_SECRET=<app-secret>
FEISHU_PLATFORM=feishu   # change to 'lark' for International
EOF
```

Install and build:

```bash
npm install && npm run build
```

Verify build succeeds (exit 0) before continuing.

## Phase 4: Register a chat

Ask: **Group chat or direct message?**

**For group chat:**
1. Add the bot to the group in Feishu/Lark
2. Get the group Chat ID — it starts with `oc_` (visible in group settings or URL)
3. Construct the JID: `<chat_id>@feishu` (e.g. `oc_abc123@feishu`)

**For direct message:**
1. Open a DM with the bot
2. The chat ID (JID) can be found in the startup logs after the next step — search for `onChatMetadata` with `@feishu`

Register the chat:

```bash
npx tsx src/cli.ts register --jid "<chat-id>@feishu" --name "<chat-name>"
```

For the main group (no trigger required):

```bash
npx tsx src/cli.ts register --jid "<chat-id>@feishu" --name "<chat-name>" --is-main
```

## Phase 5: Restart and verify

Restart the service:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Send a test message in Feishu:
- Main/DM group: any message
- Non-main group: use the trigger word (default: `@Andy`)

Check logs if no response:

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

**No messages arriving:**
- Confirm the bot has the `im:message.receive_v1` event subscription
- Confirm connection mode is set to **Long Connection (WebSocket)** in the portal
- Check logs for `Connected to Feishu via WebSocket`

**Auth errors:**
- Double-check App ID and App Secret in `.env`
- Make sure the app version is published and approved

**Bot sends but doesn't receive:**
- Confirm the bot is added to the group/DM
- Confirm `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are non-empty in `.env`

**Wrong platform (Feishu vs Lark):**
- Set `FEISHU_PLATFORM=lark` in `.env` for International, `feishu` for China
- Rebuild and restart after changing

## Removal

```bash
# Remove credentials from .env (edit manually, remove FEISHU_* lines)
# Remove registered groups
sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE '%@feishu'"
# Rebuild
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
