name: add-feishu
description: "Add Feishu/Lark as a channel using WebSocket for real-time messages, auto-register groups, and auto-cleanup on group disband"
---

# Add Feishu/Lark Channel

This skill adds Feishu (Lark) support to NanoClaw using the official @larksuiteoapi/node-sdk with WebSocket for real-time messaging.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup).

### Ask the user

Use `AskUserQuestion` to collect:

AskUserQuestion: Do you have Feishu App ID and App Secret?
- **Yes** - Collect FEISHU_APP_ID and FEISHU_APP_SECRET now
- **No** - Tell them how to create one (see Phase 3)

AskUserQuestion: Should Feishu replace WhatsApp or run alongside it?
- **Replace WhatsApp** - Feishu will be the only channel
- **Alongside** - Both Feishu and WhatsApp channels active

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
- Adds `src/channels/feishu.ts` (FeishuChannel class implementing Channel interface)
- Three-way merges Feishu support into `src/index.ts` (multi-channel support)
- Merges config exports into `src/config.ts` (FEISHU_APP_ID, FEISHU_APP_SECRET)
- Records the application in `.nanoclaw/state.yaml`

If merge conflicts occur, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean.

## Phase 3: Setup

### Create Feishu App (if needed)

If the user doesn't have Feishu credentials, tell them:

> Create a Feishu enterprise app at https://open.feishu.cn/:
> 1. Go to "Create App" and fill in details
> 2. Go to "Permissions" and enable:
>    - `im:message:send_as_bot` - Send messages as bot
>    - `im:message:receive` - Receive messages
>    - `im:chat:readonly` - Read chat info
> 3. Go to "Events and Callbacks" and subscribe to:
>    - `im.message.receive_v1` - Message receiving
>    - `im.chat.disbanded_v1` - Group disbanded
> 4. Get `App ID` and `App Secret` from "Credentials" page
> 5. Publish the app

Wait for user to provide credentials.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret
```

### Sync to container

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Add the bot to a chat (P2P or group)
> 2. Send a message - check logs with `tail logs/nanoclaw.log`
> 3. Find the chat_id in the logs (format: `oc_xxxxxxxxxxxxx`)

### Auto-registration

For group chats, the bot will automatically:
1. Create a new folder `groups/group-xxxxxxxxxx`
2. Register the group in SQLite
3. Create isolated context for that group

For P2P chats, they need to be manually registered.

### Manual registration (if needed)

```typescript
registerGroup("oc:<chat-id>", {
  name: "chat-name",
  folder: "folder-name",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your Feishu chat:
> - For P2P: Any message works
> - For groups: The bot will auto-register and respond

### Check logs

```bash
tail -f logs/nanoclaw.log
```

## Features

- **WebSocket**: Real-time message receiving via Feishu's long-connection mode
- **Auto-register**: New group chats get automatic isolated context
- **Auto-cleanup**: Group disband removes DB entry and folders (groups/, data/sessions/, data/ipc/)
- **No trigger**: Responds to all messages by default
- **P2P & Group**: Works with direct messages and group chats

## Troubleshooting

### Bot not responding

1. Check `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are in `.env` AND synced to `data/env/env`
2. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'oc:%'"`
3. Check service running: `launchctl list | grep nanoclaw` (macOS)
4. Check logs: `tail logs/nanoclaw.log`

### Group not auto-registering

1. Ensure the bot is added to the group
2. Check WebSocket is connected: look for "ws client ready" in logs
3. Check the group chat_id format (should start with `oc_`)

### Group disband not cleaning up

1. Check bot has `im.chat.disbanded_v1` event subscribed
2. Check logs for "Group disbanded" message

## Removal

To remove Feishu integration:

1. Delete `src/channels/feishu.ts`
2. Remove `FeishuChannel` import and creation from `src/index.ts`
3. Revert to single-channel logic if Feishu was the only channel
4. Remove Feishu registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'oc:%'"`
5. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
