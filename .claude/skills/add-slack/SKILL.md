---
name: add-slack
description: Add Slack as a channel using @slack/bolt with Socket Mode. Can replace WhatsApp entirely or run alongside it.
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

AskUserQuestion: Do you have a Slack app with Socket Mode tokens, or do you need to create one?

If they have tokens, collect them now. If not, we'll create the app in Phase 3.

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
npx tsx scripts/apply-skill.ts .claude/skills/add-slack
```

This deterministically:
- Adds `src/channels/slack.ts` (SlackChannel class implementing Channel interface)
- Adds `src/channels/slack.test.ts` (unit tests)
- Three-way merges Slack support into `src/index.ts` (multi-channel support)
- Three-way merges Slack config into `src/config.ts` (SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_ONLY exports)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Installs the `@slack/bolt` npm dependency
- Updates `.env.example` with `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_ONLY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new slack tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Slack App (if needed)

If the user doesn't have tokens, tell them:

> I need you to create a Slack app with Socket Mode:
>
> 1. Go to https://api.slack.com/apps and click **Create New App**
> 2. Choose **From scratch**, name it (e.g., "Andy Assistant"), and select your workspace
>
> **Enable Socket Mode:**
> 3. Go to **Socket Mode** in the left sidebar
> 4. Toggle **Enable Socket Mode** ON
> 5. Create an app-level token with `connections:write` scope — name it "socket-token"
> 6. **Copy the `xapp-` token** — this is your `SLACK_APP_TOKEN`
>
> **Add Bot Token Scopes:**
> 7. Go to **OAuth & Permissions** in the left sidebar
> 8. Under **Bot Token Scopes**, add:
>    - `chat:write` — send messages
>    - `channels:history` — read channel messages
>    - `groups:history` — read private channel messages
>    - `im:history` — read DM messages
>    - `mpim:history` — read group DM messages
>    - `users:read` — get user display names
>    - `channels:read` — get channel info
>    - `files:read` — read file metadata
>
> **Install the App:**
> 9. Go to **Install App** in the left sidebar
> 10. Click **Install to Workspace** and authorize
> 11. **Copy the `xoxb-` Bot User OAuth Token** — this is your `SLACK_BOT_TOKEN`
>
> **Subscribe to Events:**
> 12. Go to **Event Subscriptions** in the left sidebar
> 13. Toggle **Enable Events** ON
> 14. Under **Subscribe to bot events**, add:
>     - `message.channels` — messages in public channels
>     - `message.groups` — messages in private channels
>     - `message.im` — direct messages
>     - `message.mpim` — group direct messages
>     - `app_mention` — when someone @mentions the bot
>     - `file_shared` — when files are shared
> 15. Click **Save Changes**

Wait for the user to provide both tokens.

### Configure environment

Add to `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
```

If they chose to replace WhatsApp:

```bash
SLACK_ONLY=true
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

> To get a Slack channel ID:
>
> 1. Open Slack and go to the channel you want to register
> 2. Right-click the channel name and select **View channel details** (or click the channel name at the top)
> 3. Scroll to the bottom of the **About** tab — you'll see **Channel ID** (e.g., `C1234567890`)
>
> The JID format for registration is: `slack:C1234567890`

Wait for the user to provide the channel ID.

### Register the channel

Use the IPC register flow or register directly. The channel ID, name, and folder name are needed.

For a main channel (responds to all messages, uses the `main` folder):

```typescript
registerGroup("slack:<channel-id>", {
  name: "<channel-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional channels (trigger-only):

```typescript
registerGroup("slack:<channel-id>", {
  name: "<channel-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

### Invite the Bot to the Channel

Tell the user:

> **Important:** The bot must be invited to the channel to see messages.
>
> In Slack, go to the channel and type:
> ```
> /invite @YourBotName
> ```
>
> Or mention the bot: `@YourBotName` — Slack will prompt you to invite it.

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Slack channel:
> - For main channel: Any message works
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
1. Both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set in `.env` AND synced to `data/env/env`
2. Socket Mode is enabled in the Slack app settings
3. Bot is invited to the channel (use `/invite @botname`)
4. Channel is registered in SQLite (check with: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'slack:%'"`)
5. For non-main channels: message includes trigger pattern
6. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### Bot only sees @mentions

Event subscriptions may be incomplete. Check:
1. Go to **Event Subscriptions** in your Slack app settings
2. Verify `message.channels`, `message.groups`, `message.im`, `message.mpim` are all subscribed
3. If you added new events, you may need to reinstall the app to your workspace

### "not_in_channel" errors

The bot must be explicitly invited to channels:
```
/invite @YourBotName
```

### Socket Mode connection issues

1. Verify `SLACK_APP_TOKEN` starts with `xapp-`
2. Verify Socket Mode is enabled in app settings
3. Check the app-level token has `connections:write` scope

### Getting channel ID

Alternative methods:
- In Slack desktop: Right-click channel > **Copy** > **Copy link** — the ID is in the URL
- Use Slack API: `curl -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/conversations.list`

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

To remove Slack integration:

1. Delete `src/channels/slack.ts` and `src/channels/slack.test.ts`
2. Remove `SlackChannel` import and creation from `src/index.ts`
3. Remove `SLACK_ONLY` from the WhatsApp conditional in `main()`
4. Remove Slack config (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ONLY`) from `src/config.ts`
5. Remove Slack registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'slack:%'"`
6. Uninstall: `npm uninstall @slack/bolt`
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
