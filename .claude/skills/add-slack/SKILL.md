---
name: add-slack
description: Add Slack as a channel. Can replace WhatsApp entirely or run alongside it. Uses Bolt SDK with Socket Mode — no public URL required.
---

# Add Slack Channel

This skill adds Slack support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `slack` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Should Slack replace WhatsApp or run alongside it?
- **Replace WhatsApp** - Slack will be the only channel (sets SLACK_ONLY=true)
- **Alongside** - Both Slack and WhatsApp channels active

AskUserQuestion: Do you have a Slack bot token and app token, or do you need to create an app?

If they have tokens, collect them now. If not, we'll create the app in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-slack
```

This deterministically:
- Adds `src/channels/slack.ts` (SlackChannel class implementing Channel interface)
- Three-way merges Slack support into `src/index.ts` (conditional WhatsApp init, Slack channel init)
- Three-way merges Slack config into `src/config.ts` (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ONLY)
- Installs the `@slack/bolt` npm dependency
- Updates `.env.example` with `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ONLY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Create a Slack App

If the user doesn't have tokens, walk them through creating a Slack app:

> I need you to create a Slack app with Socket Mode:
>
> 1. Go to https://api.slack.com/apps and click **Create New App** → **From scratch**
> 2. Name it (e.g. "Andy") and pick your workspace
> 3. In **Socket Mode** (left sidebar): enable **Enable Socket Mode** and create an App-Level Token with the `connections:write` scope → copy the `xapp-*` token
> 4. In **OAuth & Permissions** (left sidebar): add these **Bot Token Scopes**:
>    - `chat:write` — post messages
>    - `channels:history` — read channel messages
>    - `groups:history` — read private channel messages
>    - `im:history` — read DMs
>    - `mpim:history` — read group DMs
>    - `users:read` — resolve display names
> 5. In **Event Subscriptions**: enable events and subscribe to the **Bot Events**:
>    - `message.channels`
>    - `message.groups`
>    - `message.im`
>    - `message.mpim`
> 6. In **OAuth & Permissions**: click **Install to Workspace** → copy the `xoxb-*` Bot User OAuth Token
> 7. Invite the bot to the channel: `/invite @YourBotName` in Slack

Wait for the user to provide both tokens.

## Phase 4: Configure Environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

If they chose to replace WhatsApp:

```bash
SLACK_ONLY=true
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4b: Enable Agents & Assistants

This is required for replies to appear in the **Chat tab** (instead of History):

1. Go to **https://api.slack.com/apps** → select your app
2. In the left sidebar click **Agents & Assistants** (under Features)
3. Toggle it **ON** → **Save**

## Phase 5: Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 6: Register the Channel

### Get Channel ID

Tell the user:

> To find the channel ID in Slack:
> - Right-click the channel name → **View channel details**
> - Scroll to the bottom — the channel ID is at the bottom (format: `C0XXXXXXXXX`)
> - For DMs: open the DM, the URL contains the ID (`D0XXXXXXXXX`)

### Register the chat

For a main chat (responds to all messages, uses the `main` folder):

```typescript
registerGroup("slack:C0XXXXXXXXX", {
  name: "general",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional channels (trigger-only):

```typescript
registerGroup("slack:C0XXXXXXXXX", {
  name: "channel-name",
  folder: "channel-name",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

Or use the SQLite CLI directly:

```bash
sqlite3 store/messages.db "INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger) VALUES ('slack:C0XXXXXXXXX', 'general', 'main', '@Andy', datetime('now'), 0)"
```

## Phase 7: Verify

Tell the user:

> Send a message in the registered Slack channel:
> - For main channel: any message should trigger a response
> - For non-main: `@Andy hello`
>
> The bot should respond within a few seconds.

Check logs if needed:

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set in `.env` and synced to `data/env/env`
2. Verify the channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'slack:%'"`
3. Confirm the bot is in the channel: `/invite @YourBotName` in Slack
4. Check Socket Mode is enabled in the Slack app settings
5. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Replies appear in History tab instead of Chat tab

Enable **Agents & Assistants** in the Slack app settings (see Phase 4b). Without this, `chat.postMessage` posts standalone messages that land in History. With it enabled, the `Assistant` middleware routes replies into the correct Chat tab thread.

### Missing scopes error

Add the missing scope in the Slack app's **OAuth & Permissions** page, then reinstall the app to the workspace.

### Bot sees its own messages

The `bot_id` field on Slack messages is used to detect bot-sent messages. They are stored with `is_bot_message: true` and filtered out from agent prompts by the message loop.

## Removal

To remove Slack integration:

1. Delete `src/channels/slack.ts`
2. Remove `SlackChannel` import and initialization from `src/index.ts`
3. Revert `if (!SLACK_ONLY)` guard around WhatsApp init to unconditional
4. Remove `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ONLY` from `src/config.ts`
5. Remove Slack registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'slack:%'"`
6. Uninstall: `npm uninstall @slack/bolt`
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
