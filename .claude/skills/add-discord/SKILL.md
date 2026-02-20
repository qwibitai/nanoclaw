# Add Discord Channel

This skill adds Discord support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `discord` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Mode**: Replace WhatsApp or add alongside it?
   - Replace → will set `DISCORD_ONLY=true`
   - Alongside → both channels active (default)

2. **Do they already have a bot token?** If yes, collect it now. If no, we'll create one in Phase 3.

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
npx tsx scripts/apply-skill.ts .claude/skills/add-discord
```

This deterministically:
- Adds `src/channels/discord.ts` (DiscordChannel class implementing Channel interface)
- Adds `src/channels/discord.test.ts` (unit tests with discord.js mock)
- Three-way merges Discord support into `src/index.ts` (multi-channel support, findChannel routing)
- Three-way merges Discord config into `src/config.ts` (DISCORD_BOT_TOKEN, DISCORD_ONLY exports)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Installs the `discord.js` npm dependency
- Updates `.env.example` with `DISCORD_BOT_TOKEN` and `DISCORD_ONLY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new Discord tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Discord Bot (if needed)

If the user doesn't have a bot token, tell them:

> I need you to create a Discord bot:
>
> 1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
> 2. Click **New Application** and give it a name (e.g., "Andy Assistant")
> 3. Go to the **Bot** tab on the left sidebar
> 4. Click **Reset Token** to generate a new bot token — copy it immediately (you can only see it once)
> 5. Under **Privileged Gateway Intents**, enable:
>    - **Message Content Intent** (required to read message text)
>    - **Server Members Intent** (optional, for member display names)
> 6. Go to **OAuth2** > **URL Generator**:
>    - Scopes: select `bot`
>    - Bot Permissions: select `Send Messages`, `Read Message History`, `View Channels`
>    - Copy the generated URL and open it in your browser to invite the bot to your server

Wait for the user to provide the token.

### Configure environment

Add to `.env`:

```bash
DISCORD_BOT_TOKEN=<their-token>
```

If they chose to replace WhatsApp:

```bash
DISCORD_ONLY=true
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

> To get the channel ID for registration:
>
> 1. In Discord, go to **User Settings** > **Advanced** > Enable **Developer Mode**
> 2. Right-click the text channel you want the bot to respond in
> 3. Click **Copy Channel ID**
>
> The channel ID will be a long number like `1234567890123456`.

Wait for the user to provide the channel ID (format: `dc:1234567890123456`).

### Register the channel

Use the IPC register flow or register directly. The channel ID, name, and folder name are needed.

For a main channel (responds to all messages, uses the `main` folder):

```typescript
registerGroup("dc:<channel-id>", {
  name: "<server-name> #<channel-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional channels (trigger-only):

```typescript
registerGroup("dc:<channel-id>", {
  name: "<server-name> #<channel-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Discord channel:
> - For main channel: Any message works
> - For non-main: @mention the bot in Discord
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `DISCORD_BOT_TOKEN` is set in `.env` AND synced to `data/env/env`
2. Check channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'dc:%'"`
3. For non-main channels: message must include trigger pattern (@mention the bot)
4. Service is running: `launchctl list | grep nanoclaw`
5. Verify the bot has been invited to the server (check OAuth2 URL was used)

### Bot only responds to @mentions

This is the default behavior for non-main channels (`requiresTrigger: true`). To change:
- Update the registered group's `requiresTrigger` to `false`
- Or register the channel as the main channel

### Message Content Intent not enabled

If the bot connects but can't read messages, ensure:
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Select your application > **Bot** tab
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
4. Restart NanoClaw

### Getting Channel ID

If you can't copy the channel ID:
- Ensure **Developer Mode** is enabled: User Settings > Advanced > Developer Mode
- Right-click the channel name in the server sidebar > Copy Channel ID

## After Setup

The Discord bot supports:
- Text messages in registered channels
- Attachment descriptions (images, videos, files shown as placeholders)
- Reply context (shows who the user is replying to)
- @mention translation (Discord `<@botId>` → NanoClaw trigger format)
- Message splitting for responses over 2000 characters
- Typing indicators while the agent processes
