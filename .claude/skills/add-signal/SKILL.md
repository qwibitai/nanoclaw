---
name: add-signal
description: Add Signal messenger channel via signal-cli JSON-RPC daemon. Native adapter — no npm dependencies, no Chat SDK bridge. Supports GroupV2 routing, voice transcription, reactions, image attachments, auto-reconnect, and contact approval.
---

# Add Signal Channel (V2)

Native Signal adapter for NanoClaw V2 using signal-cli's JSON-RPC daemon over TCP. Zero npm dependencies — communicates directly with signal-cli via a persistent TCP socket.

**Battle-tested:** Production-proven on NanoClaw V2 since April 2026. Handles DMs, GroupV2 groups, voice notes (local Whisper transcription), image attachments, emoji reactions, sealed sender, and automatic daemon reconnection.

## Features

- **GroupV2 routing** — correctly extracts group IDs from `dataMessage.groupV2.id` with legacy fallback
- **Voice transcription** — automatically transcribes voice notes via local whisper-cli (falls back to OpenAI Whisper API)
- **Image attachments** — mounts signal-cli attachment directory into agent containers (read-only)
- **Emoji reactions** — send and receive reactions via signal-cli's sendReaction RPC
- **Auto-reconnect** — TCP socket reconnects on disconnect with 5s backoff
- **Watchdog** — restarts signal-cli daemon if no group messages received for 6 hours
- **Contact approval** — unregistered DMs are held for admin approval, not silently dropped
- **Sealed sender** — works with signal-cli >= 0.13.22
- **Linked device mode** — NanoClaw runs as a linked device, phone stays primary

## Prerequisites

### 1. Java 17+

signal-cli requires Java:

```bash
java -version
# If missing:
# Debian/Ubuntu: sudo apt install -y default-jre
# RHEL/Fedora:   sudo dnf install -y java-17-openjdk
# macOS:         brew install --cask temurin@17
```

### 2. signal-cli

Install the latest release:

```bash
SIGNAL_CLI_VERSION=$(curl -fsSL https://api.github.com/repos/AsamK/signal-cli/releases/latest | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'][1:])")
curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}.tar.gz" \
  | sudo tar -xz -C /opt
sudo ln -sf /opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli /usr/local/bin/signal-cli
signal-cli --version
```

Version 0.13.22+ required (sealed sender support).

### 3. ffmpeg (for voice transcription)

```bash
# Debian/Ubuntu
sudo apt install -y ffmpeg
# macOS
brew install ffmpeg
```

### 4. Register a Signal account

**Option A — Dedicated number (recommended):**

```bash
# Get a captcha token: open https://signalcaptchas.org/registration/generate.html
# Solve captcha, right-click "Open Signal", copy link, extract token after signalcaptcha://

signal-cli -a +YOURNUMBER register --captcha "CAPTCHA_TOKEN"
# Wait for SMS code, then:
signal-cli -a +YOURNUMBER verify CODE
```

**Option B — Linked device (share existing number):**

```bash
signal-cli link -n "NanoClaw"
# Scan QR code from Signal app: Settings → Linked Devices → Link New Device
```

### 5. Set up signal-cli daemon

Create a systemd user service:

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/signal-cli.service << 'EOF'
[Unit]
Description=signal-cli JSON-RPC daemon
After=network.target

[Service]
ExecStart=/usr/local/bin/signal-cli -a +YOURNUMBER daemon --tcp 127.0.0.1:7583
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now signal-cli
```

Verify it's running:

```bash
systemctl --user status signal-cli
```

## Install

### Phase 1: Pre-flight

```bash
test -f src/channels/signal.ts && echo "Already installed" || echo "Ready to install"
```

If already installed, skip to Verify.

### Phase 2: Apply

```bash
git fetch origin skill/signal-v2
git checkout origin/skill/signal-v2 -- src/channels/signal.ts
```

Add the import to `src/channels/index.ts`:

```typescript
import './signal.js';
```

Add config exports to `src/config.ts` (inside the `readEnvFile` call and as exports):

```typescript
// In the readEnvFile array, add:
'SIGNAL_PHONE_NUMBER',
'SIGNAL_CLI_TCP_HOST',
'SIGNAL_CLI_TCP_PORT',

// Add exports:
export const SIGNAL_PHONE_NUMBER = process.env.SIGNAL_PHONE_NUMBER || envConfig.SIGNAL_PHONE_NUMBER || '';
export const SIGNAL_CLI_TCP_HOST = process.env.SIGNAL_CLI_TCP_HOST || envConfig.SIGNAL_CLI_TCP_HOST || '127.0.0.1';
export const SIGNAL_CLI_TCP_PORT = parseInt(
  process.env.SIGNAL_CLI_TCP_PORT || envConfig.SIGNAL_CLI_TCP_PORT || '7583',
  10,
);
```

Add to `.env`:

```bash
SIGNAL_PHONE_NUMBER=+YOURNUMBER
```

### Phase 3: Build and restart

```bash
pnpm run build
systemctl --user restart nanoclaw     # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

## Verify

1. Send a DM to the Signal number from your phone
2. Check logs: `tail -f logs/nanoclaw.log | grep -i signal`
3. Verify you see: `Connected to signal-cli`, `Channel metadata discovered`, `Message routed`
4. Verify the agent responds in Signal

### Group test

1. Add the Signal number to a group
2. Send a message mentioning the agent's trigger word
3. Verify the message routes and the agent responds in the group (not in DMs)

## Wire to an agent

After the first DM arrives, the router auto-creates a `messaging_groups` row. Wire it:

```bash
# Find the messaging group ID
sqlite3 data/v2.db "SELECT id, platform_id, name FROM messaging_groups WHERE channel_type='signal' ORDER BY created_at DESC LIMIT 5"

# Wire to an agent group
sqlite3 data/v2.db "INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, priority, created_at) VALUES ('mga-'||hex(randomblob(8)), 'mg-YOURID', 'ag-YOURID', 'shared', 0, datetime('now'))"

# Grant user membership
sqlite3 data/v2.db "INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES ('signal:SENDER-UUID', 'ag-YOURID', NULL, datetime('now'))"
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNAL_PHONE_NUMBER` | (required) | Agent's registered Signal phone number |
| `SIGNAL_CLI_TCP_HOST` | `127.0.0.1` | signal-cli daemon host |
| `SIGNAL_CLI_TCP_PORT` | `7583` | signal-cli daemon TCP port |

## Container mounts

The adapter automatically mounts signal-cli's attachment directory into agent containers:

```
~/.local/share/signal-cli/attachments/ → /workspace/attachments (read-only)
```

This allows the agent to read images and voice notes sent via Signal.

## Architecture

```
Phone (Signal app)
  ↓ Signal protocol (encrypted)
signal-cli daemon (TCP:7583)
  ↓ JSON-RPC over TCP
NanoClaw Signal adapter (src/channels/signal.ts)
  ↓ InboundMessage
Router → Session → Container → Agent
  ↓ OutboundMessage
Signal adapter → signal-cli → Phone
```

No npm dependencies. No Chat SDK bridge. No signal-sdk wrapper. Direct TCP JSON-RPC to signal-cli.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `Connected to signal-cli` not in logs | Daemon not running | `systemctl --user status signal-cli` |
| Messages dropped with `not_member` | User not in agent group | Add to `agent_group_members` |
| Group replies go to DMs | Legacy groupInfo field | Adapter uses `groupV2.id` — update if you have an older version |
| Voice notes not transcribed | ffmpeg or whisper missing | Install ffmpeg; optionally set `WHISPER_BIN` for local transcription |
| `signal-cli socket closed, reconnecting` | Daemon restarted | Normal — auto-reconnects in 5s |
| No group messages for hours | signal-cli stale | Watchdog auto-restarts after 6h silence |

## Removal

```bash
rm src/channels/signal.ts
# Remove `import './signal.js';` from src/channels/index.ts
# Remove SIGNAL_* exports from src/config.ts
# Remove SIGNAL_PHONE_NUMBER from .env
pnpm run build
systemctl --user restart nanoclaw
```
