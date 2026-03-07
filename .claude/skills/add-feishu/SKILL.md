# Add Feishu Channel

This skill adds Feishu (飞书) support to NanoClaw using WebSocket long-connection mode. It uses a self-built app (自建应用) — no public URL or HTTPS certificate required.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to ask:

> Do you already have a Feishu self-built app with App ID and App Secret, or do you need to create one?

If they have credentials, collect them now. If not, we'll create the app in Phase 3.

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
- Adds `src/channels/feishu.ts` (FeishuChannel class with self-registration via `registerChannel`)
- Adds `src/channels/feishu.test.ts` (unit tests with `@larksuiteoapi/node-sdk` mock)
- Appends `import './feishu.js'` to `src/channels/index.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and the build must be clean before proceeding.

## Phase 3: Setup

### Create Feishu Self-Built App (if needed)

If the user doesn't have a Feishu app, tell them:

> I need you to create a Feishu self-built app:
>
> 1. Go to the [Feishu Open Platform](https://open.feishu.cn/app) and log in
> 2. Click **Create enterprise app**, give it a name (e.g., "Andy Assistant")
> 3. On the app's **Credentials & Basic Info** page, copy the **App ID** and **App Secret**
> 4. Go to **Permissions & Scopes** → click **Batch import** and paste the following JSON:
>    ```json
>    {
>      "scopes": {
>        "tenant": [
>          "aily:file:read",
>          "aily:file:write",
>          "application:application.app_message_stats.overview:readonly",
>          "application:application:self_manage",
>          "application:bot.menu:write",
>          "cardkit:card:read",
>          "cardkit:card:write",
>          "contact:user.employee_id:readonly",
>          "corehr:file:download",
>          "event:ip_list",
>          "im:chat.access_event.bot_p2p_chat:read",
>          "im:chat.members:bot_access",
>          "im:message",
>          "im:message.group_at_msg:readonly",
>          "im:message.p2p_msg:readonly",
>          "im:message:readonly",
>          "im:message:send_as_bot",
>          "im:resource"
>        ],
>        "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
>      }
>    }
>    ```
> 5. Go to **App Capability** → **Bot**, click **Enable** and set the bot name.
>    ⚠️ Without this step the app cannot send or receive messages as a bot.
> 6. Publish the app: go to **Version Management & Release** → **Create Version** → **Apply for Online**
>    (For enterprise apps, an admin must approve; for personal use, approval is immediate)

Wait for the user to confirm the app is published and provide App ID and App Secret.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Configure Event Subscription

> ⚠️ The Feishu long-connection event subscription must be configured **after** the NanoClaw service is running. If you save this before the service starts, Feishu cannot verify the connection and the setting will fail.
>
> 1. In your Feishu app, go to **Event Subscription**
> 2. Choose **Use long connection to receive events** (WebSocket mode)
> 3. Click **Add Event**, search for `im.message.receive_v1` and add it
> 4. Save — Feishu will verify the connection against the running service

## Phase 4: Registration

### Get the chat ID or open_id

For **group chat** registration, tell the user:

> To get the group chat ID:
>
> 1. Add your Feishu bot to the group (search for the app name in the group's member list)
> 2. Send any message in the group

Then run:

```bash
tail -20 logs/nanoclaw.log | grep "unregistered chat"
```

The JID appears as `fs:oc_xxxxxxxxxxxxxxxxxx`. If nothing shows up in logs, query the database directly:

```bash
sqlite3 store/messages.db "SELECT jid FROM chats WHERE jid LIKE 'fs:%' ORDER BY created_at DESC LIMIT 5;"
```

For **private chat** (direct message) registration:

> 1. Open a direct message with the bot in Feishu
> 2. Send any message

Then run:

```bash
tail -20 logs/nanoclaw.log | grep "unregistered chat"
```

The JID appears as `fs:p_ou_xxxxxxxxxxxxxxxxxx`. If nothing shows up in logs, query the database:

```bash
sqlite3 store/messages.db "SELECT jid FROM chats WHERE jid LIKE 'fs:%' ORDER BY created_at DESC LIMIT 5;"
```

### Register the group

For a main group (responds to all messages without requiring @mention):

```typescript
registerGroup("fs:<chat-id>", {
  name: "<group-name>",
  folder: "feishu_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For a non-main group (requires @bot mention to trigger):

```typescript
registerGroup("fs:<chat-id>", {
  name: "<group-name>",
  folder: "feishu_<group-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

For a private chat (main control entry — elevated privileges):

```typescript
registerGroup("fs:p_<open-id>", {
  name: "<person-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Feishu chat:
> - For main group: any message works
> - For non-main group: @mention the bot in the message
> - For private chat: any message works
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Verify the app is published and **Use Long Connection** is enabled in Feishu developer console
3. Verify the app has `im:message:receive_v1` and `im:message` permissions
4. Check the chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'fs:%'"`
5. Service is running: `launchctl list | grep nanoclaw`

### Bot connects but can't receive messages

- Ensure **Event Subscriptions** has `im.message.receive_v1` enabled
- Ensure the bot has been **added to the group** (not just invited)
- For enterprise apps: check admin approval status in **Version Management**

### Bot capability not enabled

If the bot connects (logs show `Feishu bot connected`) but cannot send or receive any messages:

1. Go to Feishu Open Platform → your app → **App Capability** → **Bot** → click **Enable**
2. Set the bot name
3. Publish a new version: **Version Management & Release** → **Create Version** → **Apply for Online**

### Bot receives messages but doesn't respond to @mentions

- Verify the bot's open_id is being fetched correctly (check logs for `Feishu bot connected`)
- If `botOpenId` is null, the `<at>` tag will not be normalised; send a full `@ASSISTANT_NAME` trigger manually

### JID format reference

| Chat type | JID format | Example |
|-----------|-----------|---------|
| Group chat | `fs:<chat_id>` | `fs:oc_a6c64a2b9eba88eeddcafe1e` |
| Private chat | `fs:p_<open_id>` | `fs:p_ou_3245842e29bc56fbfe5e45f3` |

## After Setup

The Feishu channel supports:
- Private chat (p2p) messages — always delivered to registered chats
- Group chat messages — requires `@bot` mention when `requiresTrigger: true`
- `<at user_id>` XML mention tags normalised to NanoClaw trigger format
- Message splitting for replies over 4000 UTF-8 bytes
- WebSocket long-connection — no public URL or HTTPS certificate needed
