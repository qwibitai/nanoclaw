# Add Signal Channel

*Synthesized by Jorgenclaw (AI agent) and Claude Code (host AI), with direct feedback and verification from Scott Jorgensen*

Add Signal messenger support to NanoClaw. Your agent will be able to send and receive Signal messages using a dedicated phone number — with full end-to-end encryption maintained by Signal's protocol.

> Don't be afraid to ask your AI assistant exactly where you are in the process and what to do next.

---

## What You're Setting Up

Signal doesn't have an official bot API, so this skill uses **signal-cli** — a well-established open-source command-line tool that registers a real Signal account and handles all encryption on your behalf.

The architecture has two pieces:
- **signal-cli daemon** — runs on your host machine, holds the Signal account credentials, handles encryption
- **NanoClaw SignalChannel** — runs inside the container, connects to the daemon via a Unix socket (a secure pipe between processes), sends and receives messages

Your Signal private keys never enter the container. The daemon owns them; the container gets a socket. This follows the same key-safety principle as the signing daemon architecture.

---

## What You Need Before Starting

- A phone number for your agent's Signal account
  - A VoIP number works — JMP.chat (accepts Monero/Bitcoin), MySudo, or similar
  - The number only needs to receive one SMS or voice call during registration
- Java 25 or higher on your host machine (`java --version` to check)
- NanoClaw installed and working

---

## Phase 1: Install signal-cli on the Host

### Check Java

```bash
java --version
```

You need version 25 or higher. If you don't have it:
- **macOS:** `brew install openjdk@25` (or download from adoptium.net)
- **Linux (Debian/Ubuntu):** `sudo apt install openjdk-25-jre`
- **Linux (other):** download from adoptium.net

### Download signal-cli

```bash
# Download the latest release (check https://github.com/AsamK/signal-cli/releases for current version)
VERSION="0.14.0"
wget "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux.tar.gz"
tar xf "signal-cli-${VERSION}-Linux.tar.gz"
sudo mv "signal-cli-${VERSION}" /opt/signal-cli
sudo ln -sf /opt/signal-cli/bin/signal-cli /usr/local/bin/signal-cli
```

Verify: `signal-cli --version` — you should see the version number.

---

## Phase 2: Register Your Agent's Signal Account

Replace `+15551234567` with your agent's actual phone number throughout.

### Step 1: Register

```bash
signal-cli -a +15551234567 register
```

Signal will send a verification code via SMS (or voice call if you add `--voice`).

### Step 2: Verify

```bash
signal-cli -a +15551234567 verify YOUR-CODE-HERE
```

*Success looks like:* No error output. The account is now registered.

### Step 3: Test sending

```bash
signal-cli -a +15551234567 send -m "Hello from NanoClaw setup test" +YOUR-OWN-NUMBER
```

You should receive this on your personal Signal app. If you do, registration is working.

---

## Phase 3: Run signal-cli as a Daemon

The daemon mode keeps signal-cli running continuously and exposes a socket that NanoClaw connects to.

### Create a systemd service (Linux)

```bash
sudo tee /etc/systemd/system/signal-cli.service > /dev/null << 'EOF'
[Unit]
Description=signal-cli JSON-RPC daemon
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
ExecStart=/usr/local/bin/signal-cli -a +15551234567 daemon --socket
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable signal-cli
sudo systemctl start signal-cli
```

*Success looks like:* `sudo systemctl status signal-cli` shows `Active: active (running)` in green.

The socket will appear at: `/run/user/YOUR_UID/signal-cli/socket`

Find your UID with: `id -u`

### macOS (launchd)

```bash
cat > ~/Library/LaunchAgents/com.signal-cli.daemon.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.signal-cli.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/signal-cli</string>
        <string>-a</string><string>+15551234567</string>
        <string>daemon</string><string>--socket</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.signal-cli.daemon.plist
```

---

## Phase 4: Mount the Socket into NanoClaw's Container

Add the socket path to your NanoClaw container configuration so the container can reach it.

In your group's entry in `data/registered_groups.json`, add a `containerConfig` section:

```json
{
  "YOUR_GROUP_JID": {
    "name": "...",
    "folder": "...",
    "trigger": "@Jorgenclaw",
    "containerConfig": {
      "additionalMounts": [
        {
          "hostPath": "/run/user/YOUR_UID/signal-cli",
          "containerPath": "signal-cli",
          "readonly": false
        }
      ]
    }
  }
}
```

The socket will appear inside the container at `/workspace/extra/signal-cli/socket`.

---

## Phase 5: Configure NanoClaw

Add these to your `.env` file (or NanoClaw's environment configuration):

```bash
SIGNAL_PHONE_NUMBER=+15551234567
SIGNAL_SOCKET_PATH=/workspace/extra/signal-cli/socket
```

---

## Phase 6: Apply the Skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-signal
```

Restart NanoClaw. You should see a log line:
```
[signal] connected to signal-cli daemon
```

---

## Registering Signal Contacts

When someone messages your agent's Signal number, NanoClaw receives it. To enable the agent to respond, register the contact:

```bash
# In your group's CLAUDE.md or via the agent:
# JID format: signal:<uuid>
# Find the UUID in NanoClaw logs when the first message arrives
```

The agent will log the sender's UUID on first contact. Use it to register:
```bash
CONTACT_JID="signal:550e8400-e29b-41d4-a716-446655440000"
CONTACT_NAME="Alice"
# Write to /workspace/ipc/tasks/approve_$(date +%s%N).json as documented in CLAUDE.md
```

---

## How Messages Work

**Receiving:** signal-cli receives encrypted Signal messages, decrypts them, and forwards them to NanoClaw via the socket as JSON. NanoClaw routes them to the appropriate group/agent.

**Sending:** NanoClaw calls `sendMessage()` → SignalChannel writes a JSON-RPC request to the socket → signal-cli encrypts and delivers via Signal's servers.

**Your keys stay safe:** The Signal private key lives in signal-cli's data directory on the host. It never enters the container. The container only has the socket — a one-way pipe for sending and receiving already-decrypted message text.

---

## Troubleshooting

| Problem | What it means | What to do |
|---------|--------------|------------|
| `Cannot connect to signal-cli socket` | Daemon not running or socket not mounted | Check `systemctl status signal-cli`, verify socket path in container |
| `SIGNAL_PHONE_NUMBER is required` | Env var not set | Add `SIGNAL_PHONE_NUMBER=+1...` to your .env |
| Messages arrive but agent doesn't respond | Contact not registered | Register the sender's UUID as a NanoClaw group |
| `java: command not found` | Java not installed | Install JRE 25 (see Phase 1) |
| Registration SMS never arrives | VoIP number issue | Try `--voice` flag on `register` command for a voice call instead |
| Signal account banned | Too many registrations from same IP | Use a residential IP for registration; data center IPs are flagged |

---

## Architecture Notes

**Why not the Signal API?**
Signal has no official bot API. The unofficial approaches (signal-cli vs. reverse-engineered APIs) all require registering a real phone number. signal-cli is the most mature, well-maintained option with active development since 2015.

**Why the socket approach?**
Same reason as the signing daemon for Nostr keys: the container should never hold credentials it could accidentally expose. The socket model means the container can use Signal without ever touching the account keys.

**JID format:**
- Direct messages: `signal:<uuid>` — the sender's Signal UUID (stable, unlike phone numbers)
- Groups: `signal:group:<base64-group-id>`

**Relationship to existing NanoClaw Signal support:**
NanoClaw's existing infrastructure receives messages from Signal through nanoclaw's own routing layer. This skill adds a native `SignalChannel` that NanoClaw can use as a first-class outbound channel — the same way WhatsApp, Telegram, and Marmot work.

---

*This skill was authored by Jorgenclaw (NanoClaw agent) — a NanoClaw agent who built it to enable the Signal integration that didn't exist in the marketplace.*
