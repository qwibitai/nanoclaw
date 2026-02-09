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

## 5. Configure Assistant Name and Main Channel

This step configures the trigger word and the main channel selection.

Ask the user:

> What trigger word do you want to use? (default: `Nano`)
>
> In group chats, messages starting with `@TriggerWord` will be sent to Claude.
> In your main channel (and optionally solo chats), no prefix is needed — all messages are processed.

Store their choice for use in the steps below.

If they choose something other than `Nano`, update it in:

1. `groups/global/CLAUDE.md` - Change "# Nano" and "You are Nano" to the new name
2. `groups/main/CLAUDE.md` - Same changes at the top
3. `.env` - Add `ASSISTANT_NAME=NewName`

## 6. Register Main Channel

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool** to explain the security model:

> **Important: Your "main" channel is your admin control portal.**
>
> The main channel has elevated privileges:
> - Can see messages from ALL other registered groups
> - Can manage and delete tasks across all groups
> - Can write to global memory that all groups can read
> - Has read-write access to the entire NanoClaw project
>
> **Recommendation:** Use a private DM or a channel where only you have access. This ensures only you have admin control.

Then ask the user:

> We need to register your main control channel.
>
> 1. Invite the bot to your server or open a DM with it.
>    (OAuth URL: `https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=2147483648&scope=bot`)
> 2. Send a message "hello" to the bot in the channel you want to use as Main.
>
> Tell me when you've sent the message.

After user confirms, build and start the app briefly to capture the message:

```bash
npm run build
```

Then run briefly (set Bash tool timeout to 15000ms):
```bash
npm run dev
```

Then find the Channel ID from the database:

```bash
sqlite3 store/messages.db "SELECT DISTINCT chat_jid, name FROM chats ORDER BY last_message_time DESC LIMIT 10"
```

Ask the user which channel they used and get the corresponding JID.

Write the configuration using the Channel ID. For DMs or private channels (where you want all messages processed without a trigger), set `requiresTrigger` to `false`:

```json
{
  "CHANNEL_ID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP",
    "requiresTrigger": false
  }
}
```

For groups, keep `requiresTrigger` as `true` (default).

Write to the database directly by creating a temporary registration script, or write `data/registered_groups.json` which will be auto-migrated on first run:

```bash
mkdir -p data
```

Then write `data/registered_groups.json` with the correct JID, trigger, and timestamp.

If the user chose a name other than `Andy`, also update:
1. `groups/global/CLAUDE.md` - Change "# Andy" and "You are Andy" to the new name
2. `groups/main/CLAUDE.md` - Same changes at the top

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

### 7a. Collect Directory Paths

Ask the user:
> Which directories do you want to allow access to?
>
> You can specify:
> - A parent folder like `~/projects` (allows access to anything inside)
> - Specific paths like `~/repos/my-app`
>
> List them one per line, or give me a comma-separated list.

For each directory they provide, ask:
> Should `[directory]` be **read-write** (agents can modify files) or **read-only**?
>
> Read-write is needed for: code changes, creating files, git commits
> Read-only is safer for: reference docs, config examples, templates

### 7b. Configure Non-Main Group Access

Ask the user:
> Should **non-main groups** (other Discord channels you add later) be restricted to **read-only** access even if read-write is allowed for the directory?
>
> Recommended: **Yes** - this prevents other groups from modifying files even if you grant them access to a directory.

### 7c. Create the Allowlist

Create the allowlist file based on their answers:

```bash
mkdir -p ~/.config/nanoclaw
```

Then write the JSON file. Example for a user who wants `~/projects` (read-write) and `~/docs` (read-only) with non-main read-only:

```bash
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
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
Tell the user:
> Mount allowlist configured. The following directories are now accessible.
>
> **Security notes:**
> - Sensitive paths (`.ssh`, `.gnupg`, `.aws`, credentials) are always blocked
> - This config file is stored outside the project, so agents cannot modify it
> - Changes require restarting the NanoClaw service
>
> To grant a group access to a directory, add it to their config in the SQLite `registered_groups` table.

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
