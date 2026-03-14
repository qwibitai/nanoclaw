---
name: add-discord
description: Add Discord bot channel integration to NanoClaw.
---

# Add Discord Channel

This skill adds Discord support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/discord.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Discord bot token, or do you need to create one?

If they have one, collect it now. If not, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `discord` is missing, add it:

```bash
git remote add discord https://github.com/qwibitai/nanoclaw-discord.git
```

### Merge the skill branch

```bash
git fetch discord main
git merge discord/main || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/discord.ts` (DiscordChannel class with self-registration via `registerChannel`)
- `src/channels/discord.test.ts` (unit tests with discord.js mock)
- `import './discord.js'` appended to the channel barrel file `src/channels/index.ts`
- `discord.js` npm dependency in `package.json`
- `DISCORD_BOT_TOKEN` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
npx vitest run src/channels/discord.test.ts
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
> 6. Scroll down to **"Requires OAuth2 Code Grant"** and make sure it is **OFF** — if enabled, the bot invite will fail
> 7. Invite the bot to your server using this URL (replace `YOUR_CLIENT_ID` with the value from the **General Information** tab):
>    ```
>    https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=68608
>    ```
>    (The OAuth2 URL Generator requires a redirect URI and is not suitable for bot invites)

Wait for the user to provide the token.

### Configure environment

Add to `.env`:

```bash
DISCORD_BOT_TOKEN=<their-token>
```

Channels auto-enable when their credentials are present — no extra configuration needed.

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

> To get the channel ID for registration:
>
> 1. In Discord, go to **User Settings** > **Advanced** > Enable **Developer Mode**
> 2. Right-click the text channel you want the bot to respond in
> 3. Click **Copy Channel ID**
>
> The channel ID will be a long number like `1234567890123456`.

Wait for the user to provide the channel ID (format: `dc:1234567890123456`).

### Register the channel

The channel ID, name, and folder name are needed. Use `npx tsx setup/index.ts --step register` with the appropriate flags.

For a main channel (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "dc:<channel-id>" --name "<server-name> #<channel-name>" --folder "discord_main" --trigger "@${ASSISTANT_NAME}" --channel discord --no-trigger-required --is-main
```

For additional channels (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "dc:<channel-id>" --name "<server-name> #<channel-name>" --folder "discord_<channel-name>" --trigger "@${ASSISTANT_NAME}" --channel discord
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

### "This integration requires a code grant" when inviting

Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **Bot** tab → scroll down → toggle **"Requires OAuth2 Code Grant"** OFF → Save Changes. Then try the invite URL again.

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
