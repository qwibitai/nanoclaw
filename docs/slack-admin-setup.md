# Registering the NanoClaw Bot in Slack

A step-by-step guide for Slack workspace administrators. After completing these steps, you will hand two tokens to the NanoClaw operator: a **Bot Token** and an **App Token**.

---

## What you will need

- Admin access to your Slack workspace (or the "Install Apps" permission)
- ~10 minutes

## What you will produce

| Token | Prefix | Hand to NanoClaw operator |
|-------|--------|---------------------------|
| Bot User OAuth Token | `xoxb-` | Yes |
| App-Level Token | `xapp-` | Yes |

---

## Step 1 — Create a new Slack App

1. Open <https://api.slack.com/apps> and sign in.
2. Click **Create New App** > **From scratch**.
3. Fill in:
   - **App Name:** `NanoClaw` (or any name you prefer — this is what users will see)
   - **Workspace:** select your workspace
4. Click **Create App**.

You will land on the app's **Basic Information** page.

---

## Step 2 — Enable Socket Mode

Socket Mode allows the bot to connect over a WebSocket — no public URL or firewall changes required.

1. In the left sidebar, click **Socket Mode**.
2. Toggle **Enable Socket Mode** to **On**.
3. You will be prompted to create an App-Level Token:
   - **Token Name:** `nanoclaw` (any label is fine)
   - **Scopes:** leave as default (`connections:write`)
4. Click **Generate**.
5. **Copy the token** (starts with `xapp-1-...`). Save it — you will need it at the end.

---

## Step 3 — Subscribe to Bot Events

This tells Slack which events to forward to the bot.

1. In the left sidebar, click **Event Subscriptions**.
2. Toggle **Enable Events** to **On**.
3. Expand **Subscribe to bot events** and click **Add Bot User Event**.
4. Add the following three events:

| Event name | Purpose |
|------------|---------|
| `message.channels` | Messages in public channels the bot is a member of |
| `message.groups` | Messages in private channels the bot is a member of |
| `message.im` | Direct messages sent to the bot |

5. Click **Save Changes** (bottom of page).

---

## Step 4 — Add OAuth Scopes

These scopes define what the bot is allowed to do in the workspace.

1. In the left sidebar, click **OAuth & Permissions**.
2. Scroll down to **Scopes** > **Bot Token Scopes**.
3. Click **Add an OAuth Scope** and add each scope listed below:

| Scope | Purpose |
|-------|---------|
| `chat:write` | Send messages to channels and DMs |
| `channels:history` | Read message history in public channels |
| `groups:history` | Read message history in private channels |
| `im:history` | Read direct message history |
| `channels:read` | List public channels (for channel name lookup) |
| `groups:read` | List private channels (for channel name lookup) |
| `users:read` | Resolve user IDs to display names |

> **Note:** Do *not* add any **User Token Scopes** — only Bot Token Scopes are needed.

---

## Step 5 — Install the App to the Workspace

1. In the left sidebar, click **Install App**.
2. Click **Install to Workspace**.
3. Review the requested permissions and click **Allow**.
4. **Copy the Bot User OAuth Token** (starts with `xoxb-...`). Save it — you will need it at the end.

---

## Step 6 — Add the Bot to Channels

The bot only sees messages in channels it has been explicitly added to.

For each channel you want the bot to operate in:

1. Open the channel in Slack.
2. Click the channel name at the top to open **Channel Details**.
3. Go to the **Integrations** tab.
4. Click **Add apps** and search for your bot name (e.g., `NanoClaw`).
5. Click **Add**.

Repeat for every channel the bot should monitor.

> **Tip:** For private channels, you can also type `/invite @NanoClaw` in the channel.

---

## Step 7 — Get Channel IDs

The NanoClaw operator will need the Channel ID for each channel the bot was added to.

**Option A — From the channel details panel:**
1. Open the channel and click the channel name at the top.
2. Scroll to the bottom of the details panel — the Channel ID is shown there.

**Option B — From the browser URL:**
Open the channel in Slack on the web. The URL looks like:
```
https://app.slack.com/client/TXXXXXXX/C0123456789
```
The `C0123456789` part is the Channel ID.

**Option C — Right-click the channel name:**
Right-click > **Copy link** — the Channel ID is the last segment of the URL.

---

## Step 8 — Hand Off to the NanoClaw Operator

Send the following to the person running NanoClaw:

1. **Bot User OAuth Token** — starts with `xoxb-` (from Step 5)
2. **App-Level Token** — starts with `xapp-` (from Step 2)
3. **Channel IDs** — the `C...` IDs for each channel the bot was added to (from Step 7)

> **Security:** Treat both tokens like passwords. Share them through a secure channel (e.g., a password manager, encrypted message, or in person). Do not post them in Slack or email.

---

## After Setup — What the Bot Can Do

With the configuration above, the bot can:

- Read messages in channels it has been added to (public and private)
- Send messages to those channels
- Receive and respond to direct messages
- Look up user display names

The bot **cannot**:

- Read messages in channels it has not been added to
- Manage channels, users, or workspace settings
- Access files or images (text messages only)

---

## Maintenance

### Adding the bot to new channels

Repeat Step 6 for each new channel, then send the Channel ID to the NanoClaw operator.

### Revoking access

1. Go to <https://api.slack.com/apps>, select the app.
2. Under **Basic Information**, scroll to **Delete App** to remove it entirely.
3. Or go to **Install App** > **Revoke Tokens** to disable without deleting.

### Updating permissions

If the NanoClaw operator requests additional scopes:

1. Go to **OAuth & Permissions** > **Bot Token Scopes** and add the requested scope.
2. Slack will show a banner: "Reinstall your app to apply changes."
3. Click the banner (or go to **Install App**) and click **Reinstall to Workspace**.
4. **Copy the new Bot Token** — it changes on reinstall — and send it to the operator.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot not receiving messages | Verify Socket Mode is on (Step 2), events are subscribed (Step 3), and bot is in the channel (Step 6) |
| `missing_scope` errors in bot logs | Add the missing scope in **OAuth & Permissions**, then reinstall the app |
| Bot can't send messages | Verify `chat:write` scope is present and bot is in the target channel |
| Token doesn't work after regeneration | Reinstall the app and send the new `xoxb-` token to the operator |
| Workspace policy blocks installation | Contact your Slack workspace owner to approve the app, or add it to the allowed apps list in **Manage** > **App Management** |
