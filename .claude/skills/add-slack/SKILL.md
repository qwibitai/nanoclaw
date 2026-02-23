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

AskUserQuestion: Do you have Slack bot tokens, or do you need to create a Slack app?

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
- Adds `src/channels/slack.test.ts` (unit tests with @slack/bolt mock)
- Three-way merges Slack support into `src/index.ts` (conditional channel creation)
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

All tests must pass (including the new Slack tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Slack App (if needed)

If the user doesn't have tokens, tell them:

> I need you to create a Slack app. The easiest way is using a manifest:
>
> 1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
> 2. Click **Create New App** > **From a manifest**
> 3. Select your workspace
> 4. Choose **JSON** format and paste this manifest:
>
> ```json
> {
>   "display_information": {
>     "name": "NanoClaw",
>     "description": "AI assistant powered by NanoClaw"
>   },
>   "features": {
>     "app_home": {
>       "home_tab_enabled": false,
>       "messages_tab_enabled": true,
>       "messages_tab_read_only_enabled": false
>     },
>     "bot_user": {
>       "display_name": "NanoClaw",
>       "always_online": true
>     }
>   },
>   "oauth_config": {
>     "scopes": {
>       "bot": [
>         "app_mentions:read",
>         "channels:history",
>         "channels:read",
>         "chat:write",
>         "im:history",
>         "im:read",
>         "im:write",
>         "users:read",
>         "reactions:read",
>         "reactions:write"
>       ]
>     }
>   },
>   "settings": {
>     "event_subscriptions": {
>       "bot_events": [
>         "app_mention",
>         "message.channels",
>         "message.im"
>       ]
>     },
>     "interactivity": {
>       "is_enabled": false
>     },
>     "org_deploy_enabled": false,
>     "socket_mode_enabled": true,
>     "token_rotation_enabled": false
>   }
> }
> ```
>
> 5. Click **Create**
> 6. Go to **Install App** (left sidebar) > **Install to Workspace** > **Allow**
> 7. Copy the **Bot User OAuth Token** (starts with `xoxb-`) from the **OAuth & Permissions** page
> 8. Go to **Basic Information** (left sidebar) > scroll to **App-Level Tokens** > **Generate Token and Scopes**
>    - Name: `socket-mode`
>    - Add scope: `connections:write`
>    - Click **Generate**
>    - Copy the token (starts with `xapp-`)

Wait for the user to provide both tokens.

### Configure environment

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
cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Get Channel ID

Tell the user:

> To register a Slack channel:
>
> 1. Open the channel in Slack
> 2. Click the channel name at the top
> 3. Scroll to the bottom — the **Channel ID** is shown (e.g., `C1234567890`)
> 4. Make sure to invite the bot: type `/invite @NanoClaw` in the channel
>
> Tell me the channel name and Channel ID.

Wait for the user to provide the channel ID (format: `slack:C<id>`).

### Register the channel

Use the IPC register flow or register directly. The channel ID, name, and folder name are needed.

For a main channel (responds to all messages, uses the `main` folder):

```typescript
registerGroup("slack:<channel-id>", {
  name: "#<channel-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional channels (trigger-only):

```typescript
registerGroup("slack:<channel-id>", {
  name: "#<channel-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Slack channel:
> - For main channel: Any message works
> - For non-main: @mention the bot in Slack
>
> The bot should respond within a few seconds. You'll see an hourglass emoji reaction while it's processing.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set in `.env` AND synced to `data/env/env`
2. Check channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'slack:%'"`
3. For non-main channels: message must include trigger pattern (@mention the bot)
4. Service is running: `launchctl list | grep nanoclaw`
5. Verify the bot has been invited to the channel (`/invite @BotName`)

### "not_in_channel" error

The bot must be explicitly invited to each channel. Type `/invite @BotName` in the Slack channel.

### Socket Mode not connecting

1. Verify `SLACK_APP_TOKEN` starts with `xapp-` (not `xoxb-`)
2. Verify the app-level token has the `connections:write` scope
3. Verify Socket Mode is enabled in the app settings (Settings > Socket Mode)

### Bot only responds to @mentions

This is the default behavior for non-main channels (`requiresTrigger: true`). To change:
- Update the registered group's `requiresTrigger` to `false`
- Or register the channel as the main channel

### Getting Channel ID

If you can't find the channel ID:
- Click the channel name at the top of the channel
- Scroll to the bottom of the dialog — Channel ID is shown there
- It starts with `C` for channels or `D` for DMs

## After Setup

The Slack bot supports:
- Text messages in registered channels via @mentions
- Direct messages (DMs) without trigger needed
- File attachment descriptions (images, videos, files shown as placeholders)
- @mention translation (Slack `<@botId>` to NanoClaw trigger format)
- Message splitting for responses over 3900 characters
- Thread replies (responses posted as replies to the triggering message)
- Typing indicators via hourglass emoji reaction on the trigger message
