---
name: add-mattermost
description: Add Mattermost as a channel. Can replace WhatsApp entirely or run alongside it.
---

# Add Mattermost Channel

This skill adds Mattermost support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `mattermost` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Should Mattermost replace WhatsApp or run alongside it?
- **Replace WhatsApp** - Mattermost will be the only channel (sets MATTERMOST_ONLY=true)
- **Alongside** - Both Mattermost and WhatsApp channels active

AskUserQuestion: Do you have a Mattermost bot token, or do you need to create one?

If they have one, collect it now. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-mattermost
```

This deterministically:
- Adds `src/channels/mattermost.ts` (MattermostChannel class implementing Channel interface)
- Adds `src/channels/mattermost.test.ts` (unit tests with mock fetch)
- Three-way merges Mattermost support into `src/index.ts` (multi-channel support, findChannel routing)
- Three-way merges Mattermost config into `src/config.ts` (MATTERMOST_URL, MATTERMOST_BOT_TOKEN, MATTERMOST_ONLY exports)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Updates `.env.example` with `MATTERMOST_URL`, `MATTERMOST_BOT_TOKEN`, and `MATTERMOST_ONLY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new Mattermost tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Mattermost Bot (if needed)

If the user doesn't have a bot token, tell them:

> I need you to create a Mattermost bot:
>
> 1. Log in to your Mattermost instance as an admin
> 2. Go to **System Console** → **Integrations** → **Bot Accounts**
> 3. Enable Bot Account Creation if not already enabled
> 4. Go to **Integrations** → **Bot Accounts** → **Add Bot Account**
> 5. Fill in the details:
>    - Username: e.g., "andy-assistant"
>    - Display Name: e.g., "Andy Assistant"
> 6. Click **Create Bot Account**
> 7. After creation, click **Edit** next to the bot
> 8. Enable **Allow this bot to post to all channels**
> 9. Copy the **Token** (starts with `mytoken-`)

Wait for the user to provide the URL and token.

### Configure environment

Add to `.env`:

```bash
MATTERMOST_URL=https://your-mattermost-instance.com
MATTERMOST_BOT_TOKEN=your-bot-token
```

If they chose to replace WhatsApp:

```bash
MATTERMOST_ONLY=true
```

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

### Get Channel ID

Tell the user:

> To get the channel ID for registration:
>
> 1. In Mattermost, go to the channel you want to register
> 2. Click the channel name at the top → **View Info**
> 3. The Channel ID is shown at the bottom (a 26-character alphanumeric string like `abcdef1234567890xyz1234567890xyz`)
>
> The JID format for NanoClaw is: `mm:<channel-id>`

Wait for the user to provide the channel ID.

### Register the channel

Use the IPC register flow or register directly. The channel ID, name, and folder name are needed.

For a main channel (responds to all messages, uses the `main` folder):

```typescript
registerGroup("mm:<channel-id>", {
  name: "<channel-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional channels (trigger-only):

```typescript
registerGroup("mm:<channel-id>", {
  name: "<channel-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Mattermost channel:
> - For main channel: Any message works
> - For non-main: `@<assistant-name> hello` (using the configured trigger word)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `MATTERMOST_URL` and `MATTERMOST_BOT_TOKEN` are set in `.env` AND synced to `data/env/env`
2. Check channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'mm:%'"`
3. For non-main channels: message must include trigger pattern
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Bot connected but not receiving messages

1. Verify the bot has been added to the channel
2. Verify the bot has permission to read messages in the channel
3. Check that the bot account is enabled in System Console

### Bot can send but not receive

1. Go to **System Console** → **Integrations** → **Bot Accounts**
2. Find your bot and click **Edit**
3. Ensure **Allow this bot to post to all channels** is enabled
4. Also check **Bot Capabilities** → **Read team and channel membership** is enabled

### Getting Channel ID

The channel ID can also be found:
- Using Mattermost API: `curl -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" $MATTERMOST_URL/api/v4/channels | jq '.[] | {id, display_name, name}'`
- In the channel header click menu → "View Info"

## After Setup

The Mattermost channel supports:
- **Public channels** — Bot must be added to the channel
- **Private channels** — Bot must be invited to the channel
- **Direct messages** — Users can DM the bot directly
- **Multi-channel** — Can run alongside WhatsApp (default) or replace it (`MATTERMOST_ONLY=true`)

## Known Limitations

- **No real-time websocket** — Uses polling (every 2 seconds) for new messages. A future version could add websocket support via Mattermost's WebSocket API.
- **No typing indicator** — Mattermost's bot API doesn't expose a typing indicator endpoint. The `setTyping()` method is a no-op.
- **Message splitting is naive** — Long messages are split at a fixed 4000-character boundary.
- **No file/image handling** — The bot only processes text content. File uploads, images, and rich message blocks are not forwarded to the agent.

## Removal

To remove Mattermost integration:

1. Delete `src/channels/mattermost.ts`
2. Remove `MattermostChannel` import and creation from `src/index.ts`
3. Remove `channels` array and revert to using `whatsapp` directly
4. Revert `getAvailableGroups()` filter to only include `@g.us` chats
5. Remove Mattermost config (`MATTERMOST_URL`, `MATTERMOST_BOT_TOKEN`, `MATTERMOST_ONLY`) from `src/config.ts`
6. Remove Mattermost registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'mm:%'"`
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
