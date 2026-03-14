# Add Feishu Channel

This skill adds Feishu (Lark) support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Feishu app ID and secret, or do you need to create a bot app?

If they have credentials, collect them now. If not, we'll create the app in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

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
- Adds `src/channels/feishu.test.ts` (unit tests with Lark SDK mock)
- Appends `import './feishu.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new Feishu tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Feishu Bot App (if needed)

If the user doesn't have credentials, tell them:

> I need you to create a Feishu custom bot app:
>
> 1. Go to [Feishu Open Platform](https://open.feishu.cn/app) (or Lark: https://open.larksuite.com/app)
> 2. Click **Create Custom App**
> 3. Give it a name (e.g., "Andy Assistant") and description
> 4. In the app dashboard, go to **Credentials & Basic Info** — copy the **App ID** and **App Secret**
> 5. Go to **Permissions & Scopes**, add these permissions:
>    - `im:message` (Read/Send messages)
>    - `im:message.receive_v1` (Receive message events)
>    - `contact:user.base:readonly` (Read basic user info — for sender names)
>    - `im:chat:readonly` (Read chat info — for chat names)
> 6. Go to **Event Subscriptions** > **Add Event** > search for `im.message.receive_v1` and subscribe
> 7. Go to **Bot** tab and enable the bot feature
> 8. Publish the app (submit for review, or if internal enterprise app, publish directly)

Wait for the user to provide the App ID and App Secret.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret_here
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

## Phase 4: Registration

### Get Chat ID

Tell the user:

> To get the chat ID for registration, you can:
>
> **Option A — From a group chat:**
> 1. Add the bot to the group (search for it in Feishu/Lark)
> 2. Send any message in the group after the bot connects — the logs will show the chat ID:
>    ```bash
>    tail -f logs/nanoclaw.log | grep "Feishu message"
>    ```
>    Look for the `chatJid` field (format: `fs:oc_xxxxxxxx`)
>
> **Option B — Direct/P2P chat:**
> 1. Start a direct message with the bot in Feishu/Lark
> 2. Send a message — the logs will show the chat ID

Wait for the user to provide the chat JID (format: `fs:oc_xxxxxxxx`).

### Register the channel

Use the IPC register flow or register directly. The chat JID, name, and folder name are needed.

For a main channel (responds to all messages):

```typescript
registerGroup("fs:<chat-id>", {
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
registerGroup("fs:<chat-id>", {
  name: "<chat-name>",
  folder: "feishu_<chat-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Feishu/Lark chat:
> - For main channel: Any message works
> - For non-main: Use the trigger word (e.g., `@Andy hello`)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not receiving messages

1. Check `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Verify `im.message.receive_v1` event is subscribed in the Feishu app dashboard
3. Ensure the app is published (not in draft)
4. Service is running: `launchctl list | grep nanoclaw`
5. Check logs for WebSocket connection errors

### Permission errors when fetching user/chat info

Ensure these scopes are added in **Permissions & Scopes**:
- `contact:user.base:readonly`
- `im:chat:readonly`

If scopes were added after publishing, re-publish the app.

### Chat ID not appearing in logs

The bot only logs chat IDs from unregistered chats at debug level. Check debug logs:
```bash
tail -f logs/nanoclaw.log | grep -i feishu
```

### Bot only responds to trigger word

This is the default behavior for non-main channels (`requiresTrigger: true`). To change:
- Update the registered group's `requiresTrigger` to `false`
- Or register the chat as the main channel

## After Setup

The Feishu bot supports:
- Text messages in registered chats (groups and direct messages)
- Media message placeholders (images, files, audio, video shown as `[图片]`, `[文件]`, etc.)
- Sender name resolution (via Feishu Contacts API)
- Chat name resolution (via Feishu Chat API)
- WebSocket long connection (no webhook/public URL required)
- Typing indicators are not supported by the Feishu API
