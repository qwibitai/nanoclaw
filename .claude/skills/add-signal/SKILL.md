---
name: add-signal
description: Add Signal as a channel using signal-cli. Can replace WhatsApp or run alongside it.
---

# Add Signal Channel

Install and configure Signal support in NanoClaw using the signal-cli REST API container. For architecture details, security considerations, and advanced features, see [docs/SIGNAL.md](../../../docs/SIGNAL.md).

## Prerequisites

### Container Runtime

Signal-cli runs as a sidecar container using `bbernhard/signal-cli-rest-api`. Either Docker or Apple Container works.

### Signal Account

Signal doesn't have separate "bot accounts" like Telegram. The bot operates as a linked device on a real Signal account, similar to Signal Desktop.

| Approach | Pros | Cons |
|----------|------|------|
| **Dedicated number** (Recommended) | Bot has its own identity | Requires second SIM, eSIM, or VoIP number |
| **Your personal number** | No extra number needed | Bot operates as "you" |

Signal allows up to 4 linked devices. You may need to unlink an existing device first via Signal Settings > Linked Devices.

## Questions to Ask

### Step 1: Detect container runtimes

```bash
HAS_APPLE=$(which container 2>/dev/null && echo "yes" || echo "no")
HAS_DOCKER=$(which docker 2>/dev/null && echo "yes" || echo "no")
```

- If neither is found, stop and tell the user they need Docker or Apple Container installed first.
- If only one is found, use it automatically.
- If both are found, include the runtime question below.

### Step 2: Ask user preferences

Use `AskUserQuestion` with up to 4 questions in a single call:

**Question 1 (only if both runtimes)** - **header**: "Runtime", **question**: "Which container runtime should run the signal-cli sidecar?"
   - Option 1: "Apple Container (Recommended)" - "Matches the runtime used for NanoClaw's agent containers."
   - Option 2: "Docker" - "Supports docker-compose and --restart policies."

**Question 2** - **header**: "Mode", **question**: "Should Signal replace WhatsApp or run alongside it?"
   - Option 1: "Replace WhatsApp" - "Signal becomes the only channel (SIGNAL_ONLY=true)."
   - Option 2: "Run alongside" - "Both Signal and WhatsApp channels active."

**Question 3** - **header**: "Sender filter", **question**: "Within registered chats, should the bot respond to all members or only specific phone numbers?"
   - Option 1: "All members (Recommended)" - "Anyone in a registered chat can trigger the agent."
   - Option 2: "Specific numbers only" - "Only approved phone numbers are processed."

**Question 4** - **header**: "Bot's number", **question**: "What phone number is the bot's Signal account registered to?"
   - Option 1: "Dedicated number" - "I have a separate number for the bot."
   - Option 2: "My personal number" - "The bot will operate as me."

### Step 3: Follow-up

- If "Specific numbers only", ask for comma-separated phone numbers in E.164 format.
- Ask for the actual phone number in E.164 format (e.g., `+61412345678`).

## Implementation

### Step 1: Start signal-cli Container

Pin to a specific version. Signal-cli must stay compatible with Signal's servers.

#### Docker

```yaml
services:
  signal-cli:
    image: bbernhard/signal-cli-rest-api:0.97
    environment:
      - MODE=json-rpc
    volumes:
      - signal-cli-data:/home/.local/share/signal-cli
    ports:
      - "8080:8080"
    restart: unless-stopped

volumes:
  signal-cli-data:
```

```bash
docker compose up -d signal-cli
```

#### Apple Container

```bash
mkdir -p ~/.local/share/signal-cli-container
chmod 700 ~/.local/share/signal-cli-container

container pull bbernhard/signal-cli-rest-api:0.97
container run -d \
  --name signal-cli \
  -e MODE=json-rpc \
  -v ~/.local/share/signal-cli-container:/home/.local/share/signal-cli \
  -p 8080:8080 \
  bbernhard/signal-cli-rest-api:0.97
```

Note: Apple Container doesn't support `--restart` policies. Create a launchd plist for auto-restart (see Troubleshooting).

### Step 2: Link Signal Account

Wait for container readiness:

```bash
until curl -sf http://localhost:8080/v1/health > /dev/null 2>&1; do
  echo "Waiting for signal-cli to start..."
  sleep 2
done
echo "signal-cli is ready"
```

Tell the user:

> Link your Signal account:
> 1. Open **http://localhost:8080/v1/qrcodelink?device_name=nanoclaw** in your browser
> 2. Open Signal on your phone > **Settings** > **Linked Devices** > **Link New Device**
> 3. Scan the QR code
>
> The QR code expires quickly. Refresh if it fails.

Verify linking in container logs:
- Docker: `docker logs signal-cli 2>&1 | tail -20`
- Apple Container: `container logs signal-cli 2>&1 | tail -20`

### Step 3: Install WebSocket Dependency

```bash
npm install ws @types/ws
```

### Step 4: Update Environment

Add to `.env`:

```bash
SIGNAL_ACCOUNT=+61412345678      # Bot's phone number (E.164 format)
SIGNAL_HTTP_HOST=127.0.0.1
SIGNAL_HTTP_PORT=8080
SIGNAL_SPAWN_DAEMON=0            # Use container sidecar
# SIGNAL_ALLOW_FROM=+61412345678 # Optional: restrict senders
# SIGNAL_ONLY=true               # Optional: disable WhatsApp
```

Sync to container environment:

```bash
cp .env data/env/env
```

### Step 5: Update launchd Environment (macOS)

The launchd plist doesn't read `.env` files. Add these keys to `~/Library/LaunchAgents/com.nanoclaw.plist` inside `EnvironmentVariables`:

```xml
<key>SIGNAL_ACCOUNT</key>
<string>+YOUR_PHONE_NUMBER</string>
<key>SIGNAL_SPAWN_DAEMON</key>
<string>0</string>
<key>SIGNAL_HTTP_HOST</key>
<string>127.0.0.1</string>
<key>SIGNAL_HTTP_PORT</key>
<string>8080</string>
<!-- Add SIGNAL_ONLY and SIGNAL_ALLOW_FROM if needed -->
```

Reload:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Step 6: Build and Restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 7: Register a Signal Chat

Tell the user:

> Send a message to your Signal chat. Note the JID from the logs:
> - Groups: `signal:group:<groupId>`
> - DMs: `signal:<phoneNumber>`

Register via `registerGroup()` in `src/index.ts` or through the main group's IPC.

### Step 8: Test

Tell the user:

> Send a message to your registered Signal chat:
> - Main chat: Any message works
> - Other chats: `@YourTrigger hello`
>
> Check logs: `tail -f logs/nanoclaw.log`

## Troubleshooting

### Container not starting

```bash
# Docker
docker logs signal-cli

# Apple Container
container logs signal-cli
```

Common issues:
- Port 8080 in use: Change `SIGNAL_HTTP_PORT` and container port mapping
- Volume permissions: Ensure container can write to data directory

### Account not linking

1. Verify container is running: `docker ps | grep signal-cli` or `container list`
2. Test QR endpoint: `curl -sf http://localhost:8080/v1/qrcodelink?device_name=nanoclaw -o /dev/null && echo "OK" || echo "FAIL"`
3. Restart container if endpoint fails
4. Ensure Signal app is up to date

### Messages not received

1. Check container logs for "Successfully linked"
2. Verify chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'signal:%'"`
3. Check `SIGNAL_ALLOW_FROM` if configured
4. Check NanoClaw logs: `tail -f logs/nanoclaw.log`

### Apple Container auto-restart

Create `~/Library/LaunchAgents/com.signal-cli-sidecar.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.signal-cli-sidecar</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/container</string>
    <string>start</string>
    <string>signal-cli</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/signal-cli-sidecar.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/signal-cli-sidecar.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.signal-cli-sidecar.plist
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SIGNAL_ACCOUNT` | Bot's phone number (E.164) | Required |
| `SIGNAL_HTTP_HOST` | Daemon HTTP host | `127.0.0.1` |
| `SIGNAL_HTTP_PORT` | Daemon HTTP port | `8080` |
| `SIGNAL_SPAWN_DAEMON` | `0` for container sidecar | `1` |
| `SIGNAL_ALLOW_FROM` | Comma-separated allowed numbers | All |
| `SIGNAL_ONLY` | `true` to disable WhatsApp | `false` |

For security considerations, hardening options, rate limiting guidance, and extended features (polls, reactions, styling), see [docs/SIGNAL.md](../../../docs/SIGNAL.md).
