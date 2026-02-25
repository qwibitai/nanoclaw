---
name: add-slack
description: Add Slack as a channel. Can replace WhatsApp entirely or run alongside it. Uses Socket Mode (no public URL needed).
---

# Add Slack Channel

This skill adds Slack support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `slack` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Mode**: Replace WhatsApp or add alongside it?
   - Replace → will set `SLACK_ONLY=true`
   - Alongside → both channels active (default)

2. **Do they already have a Slack app configured?** If yes, collect the Bot Token and App Token now. If no, we'll create one in Phase 3.

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
- Adds `src/channels/slack.test.ts` (46 unit tests)
- Three-way merges Slack support into `src/index.ts` (multi-channel support, conditional channel creation)
- Three-way merges Slack config into `src/config.ts` (SLACK_ONLY export)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Installs the `@slack/bolt` npm dependency
- Updates `.env.example` with `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_ONLY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts
- `modify/src/routing.test.ts.intent.md` — what changed for routing tests

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new slack tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Slack App (if needed)

If the user doesn't have a Slack app, share [SLACK_SETUP.md](SLACK_SETUP.md) which has step-by-step instructions with screenshots guidance, troubleshooting, and a token reference table.

Quick summary of what's needed:
1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable Socket Mode and generate an App-Level Token (`xapp-...`)
3. Subscribe to bot events: `message.channels`, `message.groups`, `message.im`
4. Add OAuth scopes: `chat:write`, `channels:history`, `groups:history`, `im:history`, `channels:read`, `groups:read`, `users:read`
5. Install to workspace and copy the Bot Token (`xoxb-...`)

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
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Get Channel ID

Tell the user:

> 1. Add the bot to a Slack channel (right-click channel → **View channel details** → **Integrations** → **Add apps**)
> 2. In that channel, the channel ID is in the URL when you open it in a browser: `https://app.slack.com/client/T.../C0123456789` — the `C...` part is the channel ID
> 3. Alternatively, right-click the channel name → **Copy link** — the channel ID is the last path segment
>
> The JID format for NanoClaw is: `slack:C0123456789`

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

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Slack channel:
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

1. Check `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set in `.env` AND synced to `data/env/env`
2. Check channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'slack:%'"`
3. For non-main channels: message must include trigger pattern
4. Service is running: `launchctl list | grep nanoclaw`

### Bot connected but not receiving messages

1. Verify Socket Mode is enabled in the Slack app settings
2. Verify the bot is subscribed to the correct events (`message.channels`, `message.groups`, `message.im`)
3. Verify the bot has been added to the channel
4. Check that the bot has the required OAuth scopes

### Bot not seeing messages in channels

By default, bots only see messages in channels they've been explicitly added to. Make sure to:
1. Add the bot to each channel you want it to monitor
2. Check the bot has `channels:history` and/or `groups:history` scopes

### "missing_scope" errors

If the bot logs `missing_scope` errors:
1. Go to **OAuth & Permissions** in your Slack app settings
2. Add the missing scope listed in the error message
3. **Reinstall the app** to your workspace — scope changes require reinstallation
4. Copy the new Bot Token (it changes on reinstall) and update `.env`
5. Sync: `mkdir -p data/env && cp .env data/env/env`
6. Restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

### Getting channel ID

If the channel ID is hard to find:
- In Slack desktop: right-click channel → **Copy link** → extract the `C...` ID from the URL
- In Slack web: the URL shows `https://app.slack.com/client/TXXXXXXX/C0123456789`
- Via API: `curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" "https://slack.com/api/conversations.list" | jq '.channels[] | {id, name}'`

## After Setup

The Slack channel supports:
- **Public channels** — Bot must be added to the channel
- **Private channels** — Bot must be invited to the channel
- **Direct messages** — Users can DM the bot directly
- **Multi-channel** — Can run alongside WhatsApp (default) or replace it (`SLACK_ONLY=true`)

## Known Limitations

- **Threads are flattened** — Threaded replies are delivered to the agent as regular channel messages. The agent sees them but has no awareness they originated in a thread. Responses always go to the channel, not back into the thread. Users in a thread will need to check the main channel for the bot's reply. Full thread-aware routing (respond in-thread) requires pipeline-wide changes: database schema, `NewMessage` type, `Channel.sendMessage` interface, and routing logic.
- **No typing indicator** — Slack's Bot API does not expose a typing indicator endpoint. The `setTyping()` method is a no-op. Users won't see "bot is typing..." while the agent works.
- **Message splitting is naive** — Long messages are split at a fixed 4000-character boundary, which may break mid-word or mid-sentence. A smarter split (on paragraph or sentence boundaries) would improve readability.
- **No file/image handling** — The bot only processes text content. File uploads, images, and rich message blocks are not forwarded to the agent.
- **Channel metadata sync is unbounded** — `syncChannelMetadata()` paginates through all channels the bot is a member of, but has no upper bound or timeout. Workspaces with thousands of channels may experience slow startup.
- **Workspace admin policies not detected** — If the Slack workspace restricts bot app installation, the setup will fail at the "Install to Workspace" step with no programmatic detection or guidance. See SLACK_SETUP.md troubleshooting section.
