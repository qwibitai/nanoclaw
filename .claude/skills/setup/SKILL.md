---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate Discord, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run all commands automatically. Only pause when user action is required.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## 1. Install Dependencies

```bash
npm install
```

## 2. Check Docker

Verify Docker is installed and running:

```bash
docker info >/dev/null 2>&1 && echo "Docker: running" || echo "Docker: not running"
```

If not running, tell the user:

> Docker is required. Please install and start Docker.
> Linux: `sudo systemctl start docker`

## 3. Configure Discord Authentication

**USER ACTION REQUIRED**

Ask the user:

> I need your **Discord Bot Token**.
>
> 1. Go to https://discord.com/developers/applications
> 2. Create a new Application (or select existing)
> 3. Go to **Bot** tab
> 4. Click **Reset Token** to get your token
> 5. Also ensure **Message Content Intent** is enabled under "Privileged Gateway Intents"
>
> Paste your token here:

Wait for the token. Then save it to `.env`:

```bash
echo "DISCORD_BOT_TOKEN=<token>" > .env
```

## 4. Build Container Image

Build the NanoClaw agent container:

```bash
./container/build.sh
```

Verify build:

```bash
docker images | grep nanoclaw-agent
```

## 5. Configure Assistant Name

Ask the user:

> What trigger word do you want to use? (default: `Nano`)
>
> Messages starting with `@TriggerWord` will be sent to Claude.

If they choose something other than `Nano`, update it in:

1. `groups/CLAUDE.md` - Change "# Nano" and "You are Nano" to the new name
2. `groups/main/CLAUDE.md` - Same changes at the top
3. `data/registered_groups.json` - Use `@NewName` as the trigger when registering groups
4. `.env` - Add `ASSISTANT_NAME=NewName`

## 6. Register Main Channel

**USER ACTION REQUIRED**

Ask the user:

> We need to register your main control channel.
>
> 1. Invite the bot to your server or open a DM with it.
>    (OAuth URL: `https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=2147483648&scope=bot`)
> 2. Send a message "hello" to the bot in the channel you want to use as Main.
>
> Tell me when you've sent the message.

After user confirms, start the app briefly to capture the message:

```bash
timeout 10 npm run dev || true
```

Then find the Channel ID from the database:

```bash
sqlite3 store/messages.db "SELECT DISTINCT chat_jid, channel_name FROM messages ORDER BY timestamp DESC LIMIT 1"
```

Create/update `data/registered_groups.json` using the Channel ID (chat_jid) found:

```json
{
  "CHANNEL_ID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP"
  }
}
```

Ensure the groups folder exists:

```bash
mkdir -p groups/main/logs
```

## 7. Configure External Directory Access (Mount Allowlist)

Ask the user:

> Do you want the agent to be able to access any directories **outside** the NanoClaw project? (e.g. `~/projects`)

If yes, ask for paths and read-write preference.

Create `~/.config/nanoclaw/mount-allowlist.json` with the configuration.

Example:

```json
{
  "allowedRoots": [
    {
      "path": "/home/user/projects",
      "allowReadWrite": true,
      "description": "Projects"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

## 8. Configure Systemd Service

Create the service file:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/nanoclaw.service << 'EOF'
[Unit]
Description=NanoClaw Assistant
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=%h/nanoclaw
ExecStart=%h/.nvm/versions/node/v20.0.0/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
# Add other env vars here if needed

[Install]
WantedBy=default.target
EOF
```

**Note:** You might need to adjust the `ExecStart` path to match the user's Node.js path (`which node`).

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now nanoclaw
```

## 9. Test

Tell the user:

> Send `@ASSISTANT_NAME hello` in your registered channel.

Check logs:

```bash
journalctl --user -u nanoclaw -f
```
