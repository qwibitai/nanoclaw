---
name: setup
description: Run initial DotClaw setup. Use when user wants to install dependencies, configure Telegram bot, register their main channel, or start the background services. Triggers on "setup", "install", "configure dotclaw", or first-time setup requests.
---

# DotClaw Setup

Run all commands automatically. Only pause when user action is required (creating Telegram bot).

## 1. Install Dependencies

```bash
npm install
```

## 2. Install Docker

Check if Docker is installed and running:

```bash
docker --version && docker info >/dev/null 2>&1 && echo "Docker is running" || echo "Docker not running or not installed"
```

If not installed or not running, tell the user:
> Docker is required for running agents in isolated environments.
>
> **macOS:**
> 1. Download Docker Desktop from https://docker.com/products/docker-desktop
> 2. Install and start Docker Desktop
> 3. Wait for the whale icon in the menu bar to stop animating
>
> **Linux:**
> ```bash
> curl -fsSL https://get.docker.com | sh
> sudo systemctl start docker
> sudo usermod -aG docker $USER  # Then log out and back in
> ```
>
> Let me know when you've completed these steps.

Wait for user confirmation, then verify:

```bash
docker run --rm hello-world
```

**Note:** DotClaw checks that Docker is running when it starts, but does not auto-start Docker. Make sure Docker Desktop is running (macOS) or the docker service is started (Linux).

## 3. Configure Claude Authentication

Ask the user:
> Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

### Option 1: Claude Subscription (Recommended)

Ask the user:
> Want me to grab the OAuth token from your current Claude session?

If yes:
```bash
TOKEN=$(cat ~/.claude/.credentials.json 2>/dev/null | jq -r '.claudeAiOauth.accessToken // empty')
if [ -n "$TOKEN" ]; then
  echo "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN" > .env
  echo "Token configured: ${TOKEN:0:20}...${TOKEN: -4}"
else
  echo "No token found - are you logged in to Claude Code?"
fi
```

If the token wasn't found, tell the user:
> Run `claude` in another terminal and log in first, then come back here.

### Option 2: API Key

Ask if they have an existing key to copy or need to create one.

**Copy existing:**
```bash
grep "^ANTHROPIC_API_KEY=" /path/to/source/.env > .env
```

**Create new:**
```bash
echo 'ANTHROPIC_API_KEY=' > .env
```

Tell the user to add their key from https://console.anthropic.com/

**Verify:**
```bash
KEY=$(grep "^ANTHROPIC_API_KEY=" .env | cut -d= -f2)
[ -n "$KEY" ] && echo "API key configured: ${KEY:0:10}...${KEY: -4}" || echo "Missing"
```

## 4. Build Container Image

Build the DotClaw agent container:

```bash
./container/build.sh
```

This creates the `dotclaw-agent:latest` image with Node.js, Chromium, Claude Code CLI, and agent-browser.

Verify the build succeeded:

```bash
docker images | grep dotclaw-agent
echo '{}' | docker run -i --entrypoint /bin/echo dotclaw-agent:latest "Container OK" || echo "Container build failed"
```

## 5. Telegram Bot Setup

**USER ACTION REQUIRED**

Tell the user:
> I need you to create a Telegram bot. Here's how:
>
> 1. Open Telegram and search for `@BotFather`
> 2. Start a chat and send: `/newbot`
> 3. Follow the prompts:
>    - **Name:** Something friendly (e.g., "My Assistant" or your preferred name)
>    - **Username:** Must end with "bot" and be unique (e.g., "my_assistant_bot")
> 4. BotFather will give you a token like: `123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`
> 5. **Copy this token** - you'll need it in a moment
>
> Let me know when you have the token.

When they provide the token, save it to `.env`:

```bash
# Add to .env (append if file exists with other vars)
echo 'TELEGRAM_BOT_TOKEN=YOUR_TOKEN_HERE' >> .env
```

Verify the token:

```bash
source .env
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" | jq '.result.username'
```

If it returns a username, the token is valid. If it returns an error, have the user check their token.

## 6. Get Telegram Chat ID

Tell the user:
> Now I need your Telegram chat ID so I can register you as the main channel.
>
> 1. Open Telegram and search for your bot (the username from BotFather)
> 2. Start a chat with your bot and send any message (e.g., "hello")
> 3. Let me know when you've done this.

After they confirm, get the chat ID:

```bash
source .env
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" | jq '.result[-1].message.chat'
```

Save the chat ID for step 8.

## 7. Configure Assistant Name

Ask the user:
> What trigger word do you want to use? (default: `Rain`)
>
> In Telegram groups, messages starting with `@TriggerWord` will be sent to Claude.
> In your personal chat with the bot, all messages go to Claude.

If they choose something other than `Rain`, update it in these places:
1. `groups/CLAUDE.md` - Change "# Rain" and "You are Rain" to the new name
2. `groups/main/CLAUDE.md` - Same changes at the top
3. `data/registered_groups.json` - Use `@NewName` as the trigger when registering groups

Store their choice - you'll use it when creating the registered_groups.json.

## 8. Register Main Channel

Create/update `data/registered_groups.json` using the chat ID from step 6 and the assistant name from step 7:

```bash
mkdir -p data groups/main/logs

cat > data/registered_groups.json << EOF
{
  "CHAT_ID_HERE": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  }
}
EOF
```

Replace `CHAT_ID_HERE` with the actual chat ID and `@ASSISTANT_NAME` with the trigger word.

## 9. Configure External Directory Access (Mount Allowlist)

Ask the user:
> Do you want the agent to be able to access any directories **outside** the DotClaw project?
>
> Examples: Git repositories, project folders, documents you want Claude to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

If **no**, create an empty allowlist to make this explicit:

```bash
mkdir -p ~/.config/dotclaw
cat > ~/.config/dotclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
echo "Mount allowlist created - no external directories allowed"
```

Skip to the next step.

If **yes**, ask follow-up questions:

### 9a. Collect Directory Paths

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

### 9b. Configure Non-Main Group Access

Ask the user:
> Should **non-main groups** (other Telegram chats you add later) be restricted to **read-only** access even if read-write is allowed for the directory?
>
> Recommended: **Yes** - this prevents other groups from modifying files even if you grant them access to a directory.

### 9c. Create the Allowlist

Create the allowlist file based on their answers:

```bash
mkdir -p ~/.config/dotclaw
```

Then write the JSON file. Example for a user who wants `~/projects` (read-write) and `~/docs` (read-only) with non-main read-only:

```bash
cat > ~/.config/dotclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    },
    {
      "path": "~/docs",
      "allowReadWrite": false,
      "description": "Reference documents"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
```

Verify the file:

```bash
cat ~/.config/dotclaw/mount-allowlist.json
```

Tell the user:
> Mount allowlist configured. The following directories are now accessible:
> - `~/projects` (read-write)
> - `~/docs` (read-only)
>
> **Security notes:**
> - Sensitive paths (`.ssh`, `.gnupg`, `.aws`, credentials) are always blocked
> - This config file is stored outside the project, so agents cannot modify it
> - Changes require restarting the DotClaw service
>
> To grant a group access to a directory, add it to their config in `data/registered_groups.json`:
> ```json
> "containerConfig": {
>   "additionalMounts": [
>     { "hostPath": "~/projects/my-app", "containerPath": "my-app", "readonly": false }
>   ]
> }
> ```

## 10. Configure launchd Service

Generate the plist file with correct paths automatically:

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

cat > ~/Library/LaunchAgents/com.dotclaw.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dotclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PROJECT_PATH}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_PATH}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${HOME_PATH}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME_PATH}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_PATH}/logs/dotclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_PATH}/logs/dotclaw.error.log</string>
</dict>
</plist>
EOF

echo "Created launchd plist with:"
echo "  Node: ${NODE_PATH}"
echo "  Project: ${PROJECT_PATH}"
```

Build and start the service:

```bash
npm run build
mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.dotclaw.plist
```

Verify it's running:
```bash
launchctl list | grep dotclaw
```

## 11. Test

Tell the user (using the assistant name they configured):
> Send a message to your bot in Telegram.

Check the logs:
```bash
tail -f logs/dotclaw.log
```

The user should receive a response from the bot.

## Troubleshooting

**Service not starting**: Check `logs/dotclaw.error.log`

**Docker not running**:
- macOS: Start Docker Desktop from Applications
- Linux: `sudo systemctl start docker`
- Verify: `docker info`

**Container agent fails with "Claude Code process exited with code 1"**:
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`
- Verify authentication: `cat .env` (should have CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY)

**No response to messages**:
- Verify the chat ID is in `data/registered_groups.json`
- Check `logs/dotclaw.log` for errors
- Verify bot token: `curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"`

**Bot token invalid ("Unauthorized")**:
- Check TELEGRAM_BOT_TOKEN in .env
- Get a new token from @BotFather if needed

**Unload service**:
```bash
launchctl unload ~/Library/LaunchAgents/com.dotclaw.plist
```
