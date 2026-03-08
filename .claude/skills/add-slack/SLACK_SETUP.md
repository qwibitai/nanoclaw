# Slack App Setup for NanoClaw

Step-by-step guide to creating and configuring a Slack app for use with NanoClaw.

## Prerequisites

- A Slack workspace where you have admin permissions (or permission to install apps)
- Your NanoClaw instance with the `/add-slack` skill applied

## Step 1: Create the Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App**
3. Choose **From scratch**
4. Enter an app name (e.g., your `ASSISTANT_NAME` value, or any name you like)
5. Select the workspace you want to install it in
6. Click **Create App**

## Step 2: Enable Socket Mode

Socket Mode lets the bot connect to Slack without needing a public URL. This is what makes it work from your local machine.

1. In the sidebar, click **Socket Mode**
2. Toggle **Enable Socket Mode** to **On**
3. When prompted for a token name, enter something like `nanoclaw`
4. Click **Generate**
5. **Copy the App-Level Token** — it starts with `xapp-`. Save this somewhere safe; you'll need it later.

## Step 3: Subscribe to Events

This tells Slack which messages to forward to your bot.

1. In the sidebar, click **Event Subscriptions**
2. Toggle **Enable Events** to **On**
3. Under **Subscribe to bot events**, click **Add Bot User Event** and add these three events:

| Event | What it does |
|-------|-------------|
| `message.channels` | Receive messages in public channels the bot is in |
| `message.groups` | Receive messages in private channels the bot is in |
| `message.im` | Receive direct messages to the bot |

4. Click **Save Changes** at the bottom of the page

## Step 4: Set Bot Permissions (OAuth Scopes)

These scopes control what the bot is allowed to do.

1. In the sidebar, click **OAuth & Permissions**
2. Scroll down to **Scopes** > **Bot Token Scopes**
3. Click **Add an OAuth Scope** and add each of these:

| Scope | Why it's needed |
|-------|----------------|
| `chat:write` | Send messages to channels and DMs |
| `channels:history` | Read messages in public channels |
| `groups:history` | Read messages in private channels |
| `im:history` | Read direct messages |
| `channels:read` | List channels (for metadata sync) |
| `groups:read` | List private channels (for metadata sync) |
| `users:read` | Look up user display names |

## Step 5: Enable Direct Messages (App Home)

This step is required to allow users to DM the bot directly. Without it, Slack silently blocks DMs even if `message.im` is subscribed.

1. In the sidebar, click **App Home**
2. Scroll down to **Show Tabs**
3. Check **Allow users to send Slash commands and messages from the messages tab**

## Step 6: Install to Workspace

1. In the sidebar, click **Install App**
2. Click **Install to Workspace**
3. Review the permissions and click **Allow**
4. **Copy the Bot User OAuth Token** — it starts with `xoxb-`. Save this somewhere safe.

> **Note:** After changing scopes or event subscriptions, Slack sometimes shows a yellow banner prompting reinstallation. If you don't see the banner, go to **OAuth & Permissions** and click **Reinstall to Workspace** manually. The bot token (`xoxb-`) may change on reinstall — update `.env` if it does.

## Step 7: Configure NanoClaw

Add both tokens to your `.env` file:

```
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here
```

If you want Slack to replace WhatsApp entirely (no WhatsApp channel), also add:

```
SLACK_ONLY=true
```

Then sync the environment to the container:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Step 8: Add the Bot to Channels

The bot only receives messages from channels it has been explicitly added to.

1. Open the Slack channel you want the bot to monitor
2. Click the channel name at the top to open channel details
3. Go to **Integrations** > **Add apps**
4. Search for your bot name and add it

Repeat for each channel you want the bot in.

## Step 9: Get Channel IDs for Registration

You need the Slack channel ID to register it with NanoClaw.

**Option A — From the URL:**
Open the channel in Slack on the web. The URL looks like:
```
https://app.slack.com/client/TXXXXXXX/C0123456789
```
The `C0123456789` part is the channel ID.

**Option B — Right-click:**
Right-click the channel name in Slack > **Copy link** > the channel ID is the last path segment.

**Option C — Via API:**
```bash
curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  "https://slack.com/api/conversations.list" | jq '.channels[] | {id, name}'
```

The NanoClaw JID format is `slack:` followed by the channel ID, e.g., `slack:C0123456789`.

## Token Reference

| Token | Prefix | Where to find it |
|-------|--------|-----------------|
| Bot User OAuth Token | `xoxb-` | **OAuth & Permissions** > **Bot User OAuth Token** |
| App-Level Token | `xapp-` | **Basic Information** > **App-Level Tokens** (or during Socket Mode setup) |

## Troubleshooting

**Bot not receiving messages:**
- Verify Socket Mode is enabled (Step 2)
- Verify all three events are subscribed (Step 3)
- Verify the bot has been added to the channel (Step 8)

**Bot not responding to DMs:**
- Go to **App Home** and ensure **"Allow users to send Slash commands and messages from the messages tab"** is checked (Step 5)
- Verify `message.im` is in the bot event subscriptions (Step 3)
- Reinstall the app after any changes — the yellow reinstall banner doesn't always appear; use **OAuth & Permissions → Reinstall to Workspace** manually if needed

**"missing_scope" errors:**
- Go back to **OAuth & Permissions** and add the missing scope
- After adding scopes, you must **reinstall the app** to your workspace (Slack will show a banner prompting you to do this)

**Bot can't send messages:**
- Verify the `chat:write` scope is added
- Verify the bot has been added to the target channel

**Token not working:**
- Bot tokens start with `xoxb-` — if yours doesn't, you may have copied the wrong token
- App tokens start with `xapp-` — these are generated in the Socket Mode or Basic Information pages
- If you regenerated a token, update `.env` and re-sync: `cp .env data/env/env`
