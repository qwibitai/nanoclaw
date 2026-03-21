---
name: add-feishu
description: Add Feishu (Lark) as a channel. Uses WebSocket long-connection mode (no public URL needed). Can run alongside WhatsApp or other channels.
---

# Add Feishu Channel

This skill adds Feishu (Lark) support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

**Do they already have a Feishu app configured?** If yes, collect the App ID and App Secret now. If no, we'll create one in Phase 3.

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
- Adds `src/feishu-auth.ts` (interactive credentials setup script)
- Appends `import './feishu.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Adds `"auth:feishu": "tsx src/feishu-auth.ts"` to `package.json` scripts
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Create Feishu App (if needed)

Share [FEISHU_SETUP.md](FEISHU_SETUP.md) which has step-by-step setup instructions.

Quick summary of what's needed:
1. Go to [open.feishu.cn/app](https://open.feishu.cn/app) (or [open.larksuite.com/app](https://open.larksuite.com/app) for outside China)
2. Create a custom app and enable the **Bot** capability
3. In **Event Subscriptions**, enable: `im.message.receive_v1`, `im.chat.member.bot.added_v1`, `im.chat.member.bot.deleted_v1`
4. Set the connection mode to **WebSocket (Long Connection)** — no public URL needed!
5. Copy the **App ID** and **App Secret** from the Credentials & Basic Info page
6. Publish the app (even just to your own workspace)

Wait for the user to provide App ID and App Secret.

### Configure credentials

Run the interactive setup script:

```bash
npm run auth:feishu
```

This will:
- Prompt for App ID and App Secret
- Test the connection to Feishu API
- Save credentials to `store/feishu-credentials.json` with restricted permissions (600)

### Build and restart

```bash
npm run build
npm run dev
```

Or if running as a service:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Register a Feishu Group

### Find the Chat ID

Feishu uses two chat ID formats:
- `oc_xxxxxxxx` — Group chats (open_chat_id)
- `ou_xxxxxxxx` — Direct messages (open_id)

To find the chat ID:
1. Add the bot to your Feishu group (search for your app name in the group members)
2. Send any message in the group — NanoClaw will log the `chat_jid` in its logs
3. Check logs: `tail -f logs/nanoclaw.log | grep "onChatMetadata"`

The JID format for NanoClaw is the raw Feishu chat_id: `oc_xxxxxxxx` or `ou_xxxxxxxx`

Wait for the user to provide the Feishu chat ID.

### Register the group

Use the main group to register the Feishu group via IPC, or register directly.

For a group where the bot responds to all messages:
```typescript
registerGroup("oc_<chat-id>", {
  name: "<group-name>",
  folder: "feishu_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For a group that requires trigger:
```typescript
registerGroup("oc_<chat-id>", {
  name: "<group-name>",
  folder: "feishu_<group-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> 1. Send a message in your registered Feishu group
> 2. For main channel: any message works
> 3. For non-main: message with trigger word (e.g. `@Andy hello`)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i feishu
```

## Troubleshooting

### Bot not responding

1. Check `store/feishu-credentials.json` exists and is valid JSON
2. Check channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'oc_%' OR jid LIKE 'ou_%'"`
3. Check NanoClaw logs for WebSocket connection status
4. Verify Event Subscriptions are enabled in Feishu app settings

### WebSocket connection fails

1. Verify App ID and App Secret are correct (re-run `npm run auth:feishu`)
2. Check that the app is published to your workspace
3. Verify the app has bot capability enabled
4. Check internet connectivity to `open.feishu.cn` (or `open.larksuite.com`)

### Messages received but not forwarded

1. The chat must be registered in `data/registered_groups.json`
2. For group chats: the bot must be added as a member of the group
3. For DMs: send a message directly to the bot in Feishu

### Bot sends messages but they don't appear

1. Check `receive_id_type` — `chat_id` for groups (`oc_`), `open_id` for DMs (`ou_`)
2. Feishu uses "post" message type for markdown — ensure the app has message sending permission

## After Setup

The Feishu channel supports:
- **Group chats** — Bot must be added as a group member
- **Direct messages** — Users can DM the bot directly
- **Multi-channel** — Can run alongside WhatsApp or other channels (auto-enabled when credentials exist)

## Known Limitations

- **No typing indicator** — Feishu bot API does not expose a typing indicator. The `setTyping()` method is a no-op.
- **No group sync** — Unlike WhatsApp, Feishu does not batch-sync group metadata. Chat names are fetched on-demand when a message is received.
- **No file/image handling** — The bot only processes text content. File uploads, images, and other media are represented as placeholder text (e.g., `<media:image>`).
- **Post message format** — Messages are sent as Feishu "post" type with markdown. Very long messages may be truncated by Feishu's limits.
- **Domestic vs international** — The SDK endpoint differs for domestic (open.feishu.cn) vs international (open.larksuite.com) deployments. The SDK handles this automatically based on the app credentials.
