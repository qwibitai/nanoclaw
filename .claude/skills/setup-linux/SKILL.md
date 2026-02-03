# NanoClaw Setup (Linux)

Run all commands automatically. Only pause when user action is required (scanning QR codes).

## 1. Install Dependencies

```bash
npm install
```

## 2. Check Docker

```bash
docker --version && docker info > /dev/null 2>&1 && echo "Docker OK" || echo "Docker not running"
```

If Docker is not installed or not running, tell the user:
> Docker is required for running agents in isolated environments.
>
> Install Docker: https://docs.docker.com/engine/install/
>
> Make sure the Docker daemon is running:
> ```bash
> sudo systemctl start docker
> sudo systemctl enable docker
> ```
>
> Add your user to the docker group (to run without sudo):
> ```bash
> sudo usermod -aG docker $USER
> ```
> Then log out and log back in.

Wait for user confirmation, then verify:

```bash
docker run --rm hello-world
```

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

**Create/edit .env:**
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

Build the NanoClaw agent container:

```bash
./container/build.sh
```

This creates the `nanoclaw-agent:latest` image with Node.js, Chromium, Claude Code CLI, and agent-browser.

Verify:

```bash
docker images | grep nanoclaw-agent
```

## 5. WhatsApp Authentication

**USER ACTION REQUIRED**

Run the authentication script:

```bash
npm run auth
```

Tell the user:
> A QR code will appear. On your phone:
> 1. Open WhatsApp
> 2. Tap **Settings → Linked Devices → Link a Device**
> 3. Scan the QR code

Wait for the script to output "Successfully authenticated" then continue.

If it says "Already authenticated", skip to the next step.

## 6. Configure Assistant Name

Ask the user:
> What trigger word do you want to use? (default: `Andy`)
>
> Messages starting with `@TriggerWord` will be sent to Claude.

If they choose something other than `Andy`, update it in these places:
1. `groups/CLAUDE.md` - Change "# Andy" and "You are Andy" to the new name
2. `groups/main/CLAUDE.md` - Same changes at the top
3. `data/registered_groups.json` - Use `@NewName` as the trigger when registering groups

Store their choice - you'll use it when creating the registered_groups.json.

## 7. Register Main Channel

Ask the user:
> Do you want to use your **personal chat** (message yourself) or a **WhatsApp group** as your main control channel?

For personal chat:
> Send any message to yourself in WhatsApp (the "Message Yourself" chat). Tell me when done.

For group:
> Send any message in the WhatsApp group you want to use as your main channel. Tell me when done.

After user confirms, start the app briefly to capture the message:

```bash
timeout 10 npm run dev || true
```

Then find the JID from the database:

```bash
# For personal chat (ends with @s.whatsapp.net)
sqlite3 store/messages.db "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE '%@s.whatsapp.net' ORDER BY timestamp DESC LIMIT 5"

# For group (ends with @g.us)
sqlite3 store/messages.db "SELECT DISTINCT chat_jid FROM messages WHERE chat_jid LIKE '%@g.us' ORDER BY timestamp DESC LIMIT 5"
```

Create/update `data/registered_groups.json` using the JID from above and the assistant name from step 6:
```json
{
  "JID_HERE": {
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

## 8. Configure External Directory Access (Mount Allowlist)

Ask the user:
> Do you want the agent to be able to access any directories **outside** the NanoClaw project?
>
> Examples: Git repositories, project folders, documents you want Claude to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

If **no**, create an empty allowlist:

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
echo "Mount allowlist created - no external directories allowed"
```

Skip to the next step.

If **yes**, ask:
> Which directories do you want to allow access to? (e.g., ~/projects, ~/repos/my-app)
>
> Should they be **read-write** or **read-only**?

Create the allowlist based on their answers:

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
EOF
```

## 9. Configure systemd Service

Build the project first:

```bash
npm run build
mkdir -p logs
```

Create systemd user service:

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/nanoclaw.service << EOF
[Unit]
Description=NanoClaw WhatsApp Assistant
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=$(pwd)
ExecStart=$(which node) $(pwd)/dist/index.js
Restart=always
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin
Environment=HOME=$HOME

StandardOutput=append:$(pwd)/logs/nanoclaw.log
StandardError=append:$(pwd)/logs/nanoclaw.error.log

[Install]
WantedBy=default.target
EOF

echo "Created systemd service"
```

Enable and start the service:

```bash
systemctl --user daemon-reload
systemctl --user enable nanoclaw
systemctl --user start nanoclaw
```

Check status:

```bash
systemctl --user status nanoclaw
```

**Note:** For the user service to run without being logged in:

```bash
sudo loginctl enable-linger $USER
```

## 10. Test

Tell the user (using the assistant name they configured):
> Send `@ASSISTANT_NAME hello` in your registered chat.

Check the logs:
```bash
tail -f logs/nanoclaw.log
```

The user should receive a response in WhatsApp.

## Troubleshooting

**Service not starting**:
```bash
journalctl --user -u nanoclaw -f
cat logs/nanoclaw.error.log
```

**Container agent fails**:
- Check Docker is running: `docker info`
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

**No response to messages**:
- Verify trigger pattern (e.g., `@AssistantName` at start)
- Check JID in `data/registered_groups.json`
- Check `logs/nanoclaw.log` for errors

**WhatsApp disconnected**:
- Run `npm run auth` to re-authenticate
- Restart: `systemctl --user restart nanoclaw`

**Stop/disable service**:
```bash
systemctl --user stop nanoclaw
systemctl --user disable nanoclaw
```

**Run manually (for debugging)**:
```bash
systemctl --user stop nanoclaw
npm run dev
```
