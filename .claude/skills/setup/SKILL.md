---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate WhatsApp, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run all commands automatically. Only pause when user action is required (WhatsApp authentication, configuration choices).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text. This integrates with Claude's built-in question/answer system for a better experience.

## 1. Install Dependencies

```bash
npm install
```

## 2. Install Container Runtime

First, detect the platform and check what's available:

```bash
echo "Platform: $(uname -s)"
which container && echo "Apple Container: installed" || echo "Apple Container: not installed"
which docker && docker info >/dev/null 2>&1 && echo "Docker: installed and running" || echo "Docker: not installed or not running"
```

### If NOT on macOS (Linux, etc.)

Apple Container is macOS-only. Use Docker instead.

Tell the user:
> You're on Linux, so we'll use Docker for container isolation. Let me set that up now.

**Use the `/convert-to-docker` skill** to convert the codebase to Docker, then continue to Section 3.

### If on macOS

**If Apple Container is already installed:** Continue to Section 3.

**If Apple Container is NOT installed:** Ask the user:
> NanoClaw needs a container runtime for isolated agent execution. You have two options:
>
> 1. **Apple Container** (default) - macOS-native, lightweight, designed for Apple silicon
> 2. **Docker** - Cross-platform, widely used, works on macOS and Linux
>
> Which would you prefer?

#### Option A: Apple Container

Tell the user:
> Apple Container is required for running agents in isolated environments.
>
> 1. Download the latest `.pkg` from https://github.com/apple/container/releases
> 2. Double-click to install
> 3. Run `container system start` to start the service
>
> Let me know when you've completed these steps.

Wait for user confirmation, then verify:

```bash
container system start
container --version
```

**Note:** NanoClaw automatically starts the Apple Container system when it launches, so you don't need to start it manually after reboots.

#### Option B: Docker

Tell the user:
> You've chosen Docker. Let me set that up now.

**Use the `/convert-to-docker` skill** to convert the codebase to Docker, then continue to Section 3.

## 3. Configure Claude Authentication

Ask the user:
> Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

### Option 1: Claude Subscription (Recommended)

Tell the user:
> Open another terminal window and run:
> ```
> claude setup-token
> ```
> A browser window will open for you to log in. Once authenticated, the token will be displayed in your terminal. Either:
> 1. Paste it here and I'll add it to `.env` for you, or
> 2. Add it to `.env` yourself as `CLAUDE_CODE_OAUTH_TOKEN=<your-token>`

If they give you the token, add it to `.env`. **Never echo the full token in commands or output** — use the Write tool to write the `.env` file directly, or tell the user to add it themselves:

```bash
echo "CLAUDE_CODE_OAUTH_TOKEN=<token>" > .env
```

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
[ -n "$KEY" ] && echo "API key configured: ${KEY:0:7}..." || echo "Missing"
```

## 4. Build Container Image

Build the NanoClaw agent container:

```bash
./container/build.sh
```

This creates the `nanoclaw-agent:latest` image with Node.js, Chromium, Claude Code CLI, and agent-browser.

Verify the build succeeded by running a simple test (this auto-detects which runtime you're using):

```bash
if which docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
else
  echo '{}' | container run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
fi
```

## 5. WhatsApp Authentication

**USER ACTION REQUIRED**

The auth script supports two methods: QR code scanning and pairing code (phone number). Ask the user which they prefer.

The auth script writes status to `store/auth-status.txt`:
- `already_authenticated` — credentials already exist
- `pairing_code:<CODE>` — pairing code generated, waiting for user to enter it
- `authenticated` — successfully authenticated
- `failed:<reason>` — authentication failed

The script automatically handles error 515 (stream error after pairing) by reconnecting — this is normal and expected during pairing code auth.

### Ask the user which method to use

> How would you like to authenticate WhatsApp?
>
> 1. **QR code in browser** (Recommended) — Opens a page with the QR code to scan
> 2. **Pairing code** — Enter a numeric code on your phone, no camera needed
> 3. **QR code in terminal** — Run the auth command yourself in another terminal

### Option A: QR Code in Browser (Recommended)

Clean any stale auth state and start auth in background:

```bash
rm -rf store/auth store/qr-data.txt store/auth-status.txt
npm run auth
```

Run this with `run_in_background: true`.

Poll for QR data (up to 15 seconds):

```bash
for i in $(seq 1 15); do if [ -f store/qr-data.txt ]; then echo "qr_ready"; exit 0; fi; STATUS=$(cat store/auth-status.txt 2>/dev/null || echo "waiting"); if [ "$STATUS" = "already_authenticated" ]; then echo "$STATUS"; exit 0; fi; sleep 1; done; echo "timeout"
```

If `already_authenticated`, skip to the next step.

If QR data is ready, generate the QR as SVG and inject it into the HTML template:

```bash
node -e "
const QR = require('qrcode');
const fs = require('fs');
const qrData = fs.readFileSync('store/qr-data.txt', 'utf8');
QR.toString(qrData, { type: 'svg' }, (err, svg) => {
  if (err) process.exit(1);
  const template = fs.readFileSync('.claude/skills/setup/qr-auth.html', 'utf8');
  fs.writeFileSync('store/qr-auth.html', template.replace('{{QR_SVG}}', svg));
  console.log('done');
});
"
```

Then open it:

```bash
open store/qr-auth.html
```

Tell the user:
> A browser window should have opened with the QR code. It expires in about 60 seconds.
>
> Scan it with WhatsApp: **Settings → Linked Devices → Link a Device**

Then poll for completion (up to 120 seconds):

```bash
for i in $(seq 1 60); do STATUS=$(cat store/auth-status.txt 2>/dev/null || echo "waiting"); if [ "$STATUS" = "authenticated" ] || [ "$STATUS" = "already_authenticated" ]; then echo "$STATUS"; exit 0; elif echo "$STATUS" | grep -q "^failed:"; then echo "$STATUS"; exit 0; fi; sleep 2; done; echo "timeout"
```

- If `authenticated`, success — clean up with `rm -f store/qr-auth.html` and continue.
- If `failed:qr_timeout`, offer to retry (re-run the auth and regenerate the HTML page).
- If `failed:logged_out`, delete `store/auth/` and retry.

### Option B: Pairing Code

Ask the user for their phone number (with country code, no + or spaces, e.g. `14155551234`).

Clean any stale auth state and start:

```bash
rm -rf store/auth store/qr-data.txt store/auth-status.txt
npx tsx src/whatsapp-auth.ts --pairing-code --phone PHONE_NUMBER
```

Run this with `run_in_background: true`.

Poll for the pairing code (up to 15 seconds):

```bash
for i in $(seq 1 15); do STATUS=$(cat store/auth-status.txt 2>/dev/null || echo "waiting"); if echo "$STATUS" | grep -q "^pairing_code:"; then echo "$STATUS"; exit 0; elif [ "$STATUS" = "authenticated" ] || [ "$STATUS" = "already_authenticated" ]; then echo "$STATUS"; exit 0; elif echo "$STATUS" | grep -q "^failed:"; then echo "$STATUS"; exit 0; fi; sleep 1; done; echo "timeout"
```

Extract the code from the status (e.g. `pairing_code:ABC12DEF` → `ABC12DEF`) and tell the user:

> Your pairing code: **CODE_HERE**
>
> 1. Open WhatsApp on your phone
> 2. Tap **Settings → Linked Devices → Link a Device**
> 3. Tap **"Link with phone number instead"**
> 4. Enter the code: **CODE_HERE**

Then poll for completion (up to 120 seconds):

```bash
for i in $(seq 1 60); do STATUS=$(cat store/auth-status.txt 2>/dev/null || echo "waiting"); if [ "$STATUS" = "authenticated" ] || [ "$STATUS" = "already_authenticated" ]; then echo "$STATUS"; exit 0; elif echo "$STATUS" | grep -q "^failed:"; then echo "$STATUS"; exit 0; fi; sleep 2; done; echo "timeout"
```

- If `authenticated` or `already_authenticated`, success — continue to next step.
- If `failed:logged_out`, delete `store/auth/` and retry.
- If `failed:515` or timeout, the 515 reconnect should handle this automatically. If it persists, the user may need to temporarily stop other WhatsApp-connected apps on the same device.

### Option C: QR Code in Terminal

Tell the user to run the auth command in another terminal window:

> Open another terminal and run:
> ```
> cd PROJECT_PATH && npm run auth
> ```
> Scan the QR code that appears, then let me know when it says "Successfully authenticated".

Replace `PROJECT_PATH` with the actual project path (use `pwd`).

Wait for the user to confirm authentication succeeded, then continue to the next step.

## 6. Configure Assistant Name and Main Channel

This step configures three things at once: the trigger word, the main channel type, and the main channel selection.

### 6a. Ask for trigger word

Ask the user:
> What trigger word do you want to use? (default: `Andy`)
>
> In group chats, messages starting with `@TriggerWord` will be sent to Claude.
> In your main channel (and optionally solo chats), no prefix is needed — all messages are processed.

Store their choice for use in the steps below.

### 6b. Explain security model and ask about main channel type

**Use the AskUserQuestion tool** to present this:

> **Important: Your "main" channel is your admin control portal.**
>
> The main channel has elevated privileges:
> - Can see messages from ALL other registered groups
> - Can manage and delete tasks across all groups
> - Can write to global memory that all groups can read
> - Has read-write access to the entire NanoClaw project
>
> **Recommendation:** Use your personal "Message Yourself" chat or a solo WhatsApp group as your main channel. This ensures only you have admin control.
>
> **Question:** Which setup will you use for your main channel?
>
> Options:
> 1. Personal chat (Message Yourself) - Recommended
> 2. DM with a specific phone number (e.g. your other phone)
> 3. Solo WhatsApp group (just me)
> 4. Group with other people (I understand the security implications)

If they choose option 4, ask a follow-up:

> You've chosen a group with other people. This means everyone in that group will have admin privileges over NanoClaw.
>
> Are you sure you want to proceed? The other members will be able to:
> - Read messages from your other registered chats
> - Schedule and manage tasks
> - Access any directories you've mounted
>
> Options:
> 1. Yes, I understand and want to proceed
> 2. No, let me use a personal chat or solo group instead

### 6c. Register the main channel

First build, then start the app briefly to connect to WhatsApp and sync group metadata. Use the Bash tool's timeout parameter (15000ms) — do NOT use the `timeout` shell command (it's not available on macOS). The app will be killed when the timeout fires, which is expected.

```bash
npm run build
```

Then run briefly (set Bash tool timeout to 15000ms):
```bash
npm run dev
```

**For personal chat** (they chose option 1):

Personal chats are NOT synced to the database on startup — only groups are. The JID for "Message Yourself" is the bot's own number. Use the number from the WhatsApp auth step and construct the JID as `{number}@s.whatsapp.net`.

**For DM with a specific number** (they chose option 2):

Ask the user for the phone number (with country code, no + or spaces, e.g. `14155551234`), then construct the JID as `{number}@s.whatsapp.net`.

**For group** (they chose option 3 or 4):

Groups are synced on startup via `groupFetchAllParticipating`. Query the database for recent groups:
```bash
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE '%@g.us' AND jid != '__group_sync__' ORDER BY last_message_time DESC LIMIT 40"
```

Show only the **10 most recent** group names to the user and ask them to pick one. If they say their group isn't in the list, show the next batch from the results you already have. If they tell you the group name directly, look it up:
```bash
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE name LIKE '%GROUP_NAME%' AND jid LIKE '%@g.us'"
```

### 6d. Write the configuration

Once you have the JID, configure it. Use the assistant name from step 6a.

For personal chats (solo, no prefix needed), set `requiresTrigger` to `false`:

```json
{
  "JID_HERE": {
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
> Do you want the agent to be able to access any directories **outside** the NanoClaw project?
>
> Examples: Git repositories, project folders, documents you want Claude to work on.
>
> **Note:** This is optional. Without configuration, agents can only access their own group folders.

If **no**, create an empty allowlist to make this explicit:

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

If **yes**, ask follow-up questions:

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
> Should **non-main groups** (other WhatsApp chats you add later) be restricted to **read-only** access even if read-write is allowed for the directory?
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
cat ~/.config/nanoclaw/mount-allowlist.json
```

Tell the user:
> Mount allowlist configured. The following directories are now accessible:
> - `~/projects` (read-write)
> - `~/docs` (read-only)
>
> **Security notes:**
> - Sensitive paths (`.ssh`, `.gnupg`, `.aws`, credentials) are always blocked
> - This config file is stored outside the project, so agents cannot modify it
> - Changes require restarting the NanoClaw service
>
> To grant a group access to a directory, add it to their config in `data/registered_groups.json`:
> ```json
> "containerConfig": {
>   "additionalMounts": [
>     { "hostPath": "~/projects/my-app" }
>   ]
> }
> ```
> The folder appears inside the container at `/workspace/extra/<folder-name>` (derived from the last segment of the path). Add `"readonly": false` for write access, or `"containerPath": "custom-name"` to override the default name.

## 8. Configure launchd Service

Generate the plist file with correct paths automatically:

```bash
NODE_PATH=$(which node)
PROJECT_PATH=$(pwd)
HOME_PATH=$HOME

cat > ~/Library/LaunchAgents/com.nanoclaw.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
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
    <string>${PROJECT_PATH}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_PATH}/logs/nanoclaw.error.log</string>
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
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Verify it's running:
```bash
launchctl list | grep nanoclaw
```

## 9. Test

Tell the user (using the assistant name they configured):
> Send `@ASSISTANT_NAME hello` in your registered chat.
>
> **Tip:** In your main channel, you don't need the `@` prefix — just send `hello` and the agent will respond.

Check the logs:
```bash
tail -f logs/nanoclaw.log
```

The user should receive a response in WhatsApp.

## Troubleshooting

**Service not starting**: Check `logs/nanoclaw.error.log`

**Container agent fails with "Claude Code process exited with code 1"**:
- Ensure the container runtime is running:
  - Apple Container: `container system start`
  - Docker: `docker info` (start Docker Desktop on macOS, or `sudo systemctl start docker` on Linux)
- Check container logs: `cat groups/main/logs/container-*.log | tail -50`

**No response to messages**:
- Verify the trigger pattern matches (e.g., `@AssistantName` at start of message)
- Main channel doesn't require a prefix — all messages are processed
- Personal/solo chats with `requiresTrigger: false` also don't need a prefix
- Check that the chat JID is in the database: `sqlite3 store/messages.db "SELECT * FROM registered_groups"`
- Check `logs/nanoclaw.log` for errors

**Messages sent but not received by NanoClaw (DMs)**:
- WhatsApp may use LID (Linked Identity) JIDs for DMs instead of phone numbers
- Check logs for `Translated LID to phone JID` — if missing, the LID isn't being resolved
- The `translateJid` method in `src/channels/whatsapp.ts` uses `sock.signalRepository.lidMapping.getPNForLID()` to resolve LIDs
- Verify the registered JID doesn't have a device suffix (should be `number@s.whatsapp.net`, not `number:0@s.whatsapp.net`)

**WhatsApp disconnected**:
- The service will show a macOS notification
- Run `npm run auth` to re-authenticate
- Restart the service: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

**Unload service**:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```
