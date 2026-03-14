---
name: add-feishu
description: Add Feishu (Lark) as a channel. Uses WebSocket long-connection (no public server needed). Can run alongside other channels. Supports both feishu.cn and international Lark.
---

# Add Feishu Channel

This skill adds Feishu (Lark) support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/feishu.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Feishu app (with App ID and App Secret), or do you need to create one?

If they have credentials, collect them now. If not, we'll create them in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `feishu` is missing, add it:

```bash
git remote add feishu https://github.com/qwibitai/nanoclaw-feishu.git
```

### Merge the skill branch

```bash
git fetch feishu main
git merge feishu/main
```

This merges in:
- `src/channels/feishu.ts` (FeishuChannel class with self-registration via `registerChannel`)
- `src/channels/feishu.test.ts` (unit tests with Lark SDK mock)
- `import './feishu.js'` appended to the channel barrel file `src/channels/index.ts`
- `@larksuiteoapi/node-sdk` npm dependency in `package.json`
- `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_DOMAIN` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/feishu.test.ts
```

All tests must pass (including the new Feishu tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Feishu App (if needed)

If the user doesn't have an app, tell them:

> I need you to create a Feishu app on the open platform:
>
> 1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and log in
> 2. Click **Create App** > **Enterprise Self-built App**
> 3. Give it a name (e.g., "Andy Assistant") and description
> 4. In the left sidebar, go to **Capabilities** > **Add Capability** > enable **Bot**
> 5. Go to **Permissions** > search for `im:message` > enable these permissions:
>    - `im:message` (Send and receive messages)
>    - `im:message.group_at_msg` (Receive group @mention messages)
>    - `im:chat:readonly` (Read chat info)
> 6. Go to **Event Subscriptions** > select **Use Long Connection** (WebSocket)
> 7. Add event: `im.message.receive_v1` (Receive messages)
> 8. **Create Version** > **Publish** (admin approval may be required)
> 9. Go to **Credentials** page > copy the **App ID** and **App Secret**
>
> For Lark (international version), use [open.larksuite.com](https://open.larksuite.com/app) instead.

Wait for the user to provide the App ID and App Secret.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=<their-app-id>
FEISHU_APP_SECRET=<their-app-secret>
```

For Lark (international), also add:

```bash
FEISHU_DOMAIN=lark
```

Channels auto-enable when their credentials are present -- no extra configuration needed.

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

> 1. Open Feishu and find the bot (search for the bot name you created)
> 2. Send any message to the bot -- check the NanoClaw logs for the chat ID
> 3. For groups: add the bot to the group first, then send a message that @mentions the bot
>
> Check logs for the chat ID:
> ```bash
> tail -f logs/nanoclaw.log | grep "Feishu message received"
> ```
>
> The chat ID looks like `oc_xxxxx` (group) or `ou_xxxxx` (direct message).

Wait for the user to provide the chat ID (format: `fs:oc_xxxx` or `fs:ou_xxxx`).

### Register the chat

Use the IPC register flow or register directly. The chat ID, name, and folder name are needed.

For a main chat (responds to all messages):

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
  folder: "feishu_<group-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Feishu chat:
> - For main chat: Any message works
> - For non-main: `@Andy hello` or @mention the bot
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. Chat is registered in SQLite (check with: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'fs:%'"`)
3. For non-main chats: message includes trigger pattern (or @mentions the bot)
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)
5. App is published and approved on the Feishu Open Platform

### Bot not receiving messages in groups

1. Ensure the bot has been added to the group
2. Check that `im.message.receive_v1` event is subscribed
3. Verify the app has `im:message.group_at_msg` permission
4. Make sure the app version is published (draft versions don't receive events)

### WebSocket connection failing

1. Check network connectivity to `open.feishu.cn` (or `open.larksuite.com` for Lark)
2. Verify App ID and App Secret are correct
3. Check logs for specific error messages: `tail -f logs/nanoclaw.log | grep feishu`

### Using Lark (international) instead of Feishu

Set `FEISHU_DOMAIN=lark` in `.env`. Note: Lark and Feishu use different API domains and some features may differ.

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove Feishu integration:

1. Delete `src/channels/feishu.ts` and `src/channels/feishu.test.ts`
2. Remove `import './feishu.js'` from `src/channels/index.ts`
3. Remove `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_DOMAIN` from `.env`
4. Remove Feishu registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'fs:%'"`
5. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
