# Feishu (Lark) Bot Setup Guide

This guide walks you through creating and configuring a Feishu custom app to use as an NanoClaw channel.

---

## Step 1: Create a Feishu Custom App

### For Mainland China users:
1. Go to [open.feishu.cn/app](https://open.feishu.cn/app)

### For international (Lark) users:
1. Go to [open.larksuite.com/app](https://open.larksuite.com/app)

2. Log in with your Feishu / Lark account
3. Click **Create Custom App**
4. Give the app a name (e.g., "NanoClaw") and description
5. Click **Create**

---

## Step 2: Enable Bot Capability

1. In your app's dashboard, go to **Add Capabilities**
2. Select **Bot** and enable it
3. Optionally configure the bot's name and avatar

---

## Step 3: Configure Event Subscriptions

1. Go to **Event Subscriptions** in the left menu
2. Set **Request URL Verification** mode to **WebSocket (Long Connection)**
   - This means NO public URL is required!
3. In the **Add Event** section, enable these events:
   - `im.message.receive_v1` — Receive messages (**required**)
   - `im.chat.member.bot.added_v1` — Bot added to group (optional, for logging)
   - `im.chat.member.bot.deleted_v1` — Bot removed from group (optional, for logging)

---

## Step 4: Configure Permissions

1. Go to **Permissions & Scopes** (or **OAuth Scopes**)
2. Add these permissions:
   - `im:message` — Read and send messages (**required**)
   - `im:message.group_at_msg` — Receive @ messages in groups
   - `im:chat` — Access chat information (for fetching group names)
   - `contact:user.base:readonly` — Read user basic info (for resolving sender names)

---

## Step 5: Get Credentials

1. Go to **Credentials & Basic Info** in the left menu
2. Copy:
   - **App ID** (format: `cli_xxxxxxxxxx`)  
   - **App Secret** (click "View" to reveal)

Keep these safe — you'll need them in the next step.

---

## Step 6: Publish the App

For the bot to receive messages, the app must be published to your workspace:

1. Go to **Version Management & Release**
2. Click **Create Version**
3. Fill in version info and click **Save**
4. Click **Request Release** (for enterprise) or **Publish** (for self-built)
5. If enterprise approval is needed, ask your admin to approve it

**Self-built apps** in Feishu can usually be published immediately without approval.

---

## Step 7: Add Bot to Groups

1. Open the Feishu group where you want the bot to work
2. Click the group settings → **Members** → **Add Members**
3. Search for your app name and add it
4. The bot is now a member of the group

---

## Token Reference

| Credential | Format | Where to find |
|------------|--------|---------------|
| App ID | `cli_xxxxxxxxxx` | Credentials & Basic Info page |
| App Secret | Long random string | Credentials & Basic Info page (click View) |
| Encrypt Key | Optional | Event Subscriptions → Security Settings |
| Verification Token | Optional | Event Subscriptions → Security Settings |

---

## Finding Chat IDs

### Method 1: From NanoClaw logs
After adding the bot to a group and sending a message, check the logs:
```bash
tail -f logs/nanoclaw.log | grep "onChatMetadata"
```
The `jid` field in the log is the chat ID.

### Method 2: Via Feishu API
```bash
# Get all group chats the bot is in
curl -H "Authorization: Bearer $(cat store/feishu-token.txt)" \
  "https://open.feishu.cn/open-apis/im/v1/chats?bot_open_id=<BOT_OPEN_ID>"
```

### Chat ID Formats
- `oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` — Group chat
- `ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` — Direct message (user open_id)

---

## Troubleshooting

### "App not found" when adding to group
- Make sure the app is published to your workspace
- Self-built apps must be published even if just to your own workspace

### "Insufficient permissions" errors
- Go back to Permissions & Scopes and add missing permissions
- After adding permissions, **re-publish the app** (permission changes require republishing)

### Events not received
- Verify Event Subscriptions are enabled and the WebSocket mode is selected
- Check that the required events are added under "subscribed events"
- Verify the app is published

### Bot responds but messages aren't stored
- The chat must be registered in NanoClaw first
- Run the registration step in Phase 4 of the skill
