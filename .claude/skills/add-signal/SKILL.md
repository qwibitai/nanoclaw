---
name: add-signal
description: Add Signal as a channel via signal-cli jsonRpc. Can replace WhatsApp entirely or run alongside it. Requires Java 21+ and a linked Signal account.
---

# Add Signal Channel

This skill adds Signal support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `signal` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Mode**: Replace WhatsApp or add alongside it?
   - Replace → will set `SIGNAL_ONLY=true`
   - Alongside → both channels active (default)

2. **Do they have signal-cli installed?** If yes, skip to Phase 2. If no, we'll install it in Phase 3.

3. **Is their phone number already linked?** If yes, collect the number now. If no, we'll link in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-signal
```

This deterministically:
- Adds `src/channels/signal.ts` (SignalChannel class implementing Channel interface, with security hardening)
- Adds `src/channels/signal.test.ts` (35 unit tests including security tests)
- Three-way merges Signal support into `src/index.ts` (multi-channel support, findChannel routing)
- Three-way merges Signal config into `src/config.ts` (SIGNAL_PHONE_NUMBER, SIGNAL_CLI_PATH, SIGNAL_ONLY exports)
- Updates `.env.example` with `SIGNAL_PHONE_NUMBER`, `SIGNAL_CLI_PATH`, and `SIGNAL_ONLY`
- Records the application in `.nanoclaw/state.yaml`

No npm dependencies are required — signal-cli is a system-level tool (Java), not an npm package.

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new signal tests) and build must be clean before proceeding.

## Phase 3: Setup

### Install Java 21+ (if needed)

Check Java version:

```bash
java --version
```

If missing or below 21:
- **Debian/Ubuntu**: `sudo apt install openjdk-21-jre`
- **macOS**: `brew install openjdk@21`

### Install signal-cli (if needed)

Check if installed:

```bash
signal-cli --version
```

If missing:
- **macOS**: `brew install signal-cli`
- **Linux**: Download from GitHub releases (latest 0.13.x):

```bash
SIGNAL_CLI_VERSION=0.13.24
curl -L -o /tmp/signal-cli.tar.gz \
  "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux.tar.gz"
sudo tar xf /tmp/signal-cli.tar.gz -C /opt/
sudo ln -sf /opt/signal-cli-${SIGNAL_CLI_VERSION}/bin/signal-cli /usr/local/bin/signal-cli
```

### Link Signal account

Link as a secondary device (recommended — keeps your existing Signal app working):

```bash
signal-cli link -n "NanoClaw" | tee >(head -1 | qrencode -t ANSIUTF8)
```

Tell the user:

> Scan the QR code with your Signal app:
>
> 1. Open Signal on your phone
> 2. Go to **Settings** → **Linked Devices**
> 3. Tap **Link New Device** and scan the QR code
>
> Wait for the terminal to show "Associated with: +1234567890"

If `qrencode` is not installed:
- **Debian/Ubuntu**: `sudo apt install qrencode`
- **macOS**: `brew install qrencode`

### Verify signal-cli works

```bash
signal-cli -a +PHONE_NUMBER receive --timeout 5
```

Replace `+PHONE_NUMBER` with the linked number. This should complete without errors (may show existing messages).

## Phase 4: Configure & Register

### Configure environment

Add to `.env`:

```bash
SIGNAL_PHONE_NUMBER=+1234567890
```

If they chose to replace WhatsApp:

```bash
SIGNAL_ONLY=true
```

Optional — if signal-cli is not in PATH:

```bash
SIGNAL_CLI_PATH=/opt/signal-cli-0.13.24/bin/signal-cli
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
```

Restart the service (platform-dependent):
- **macOS**: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
- **Linux systemd**: `sudo systemctl restart nanoclaw`
- **Manual**: stop the running process and `npm start`

### Get Chat ID

Tell the user:

> 1. Send `/chatid` in the Signal chat you want to register (DM or group)
> 2. The bot will reply with the chat JID
>    - DMs: `signal:+15551234567`
>    - Groups: `signal:dGVzdGdyb3VwaWQ=` (base64 group ID)

Wait for the user to provide the chat ID.

### Register the chat

Use the IPC register flow or register directly. The chat ID, name, and folder name are needed.

For a main chat (responds to all messages, uses the `main` folder):

```json
// data/registered_groups.json
{
  "signal:+15551234567": {
    "name": "Signal DM",
    "folder": "main",
    "trigger": "@Andy",
    "added_at": "2024-01-01T00:00:00.000Z",
    "requiresTrigger": false
  }
}
```

For additional chats (trigger-only):

```json
{
  "signal:dGVzdGdyb3VwaWQ=": {
    "name": "Signal Group",
    "folder": "signal-group",
    "trigger": "@Andy",
    "added_at": "2024-01-01T00:00:00.000Z",
    "requiresTrigger": true
  }
}
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Signal chat:
> - For main chat: Any message works
> - For non-main: `@Andy hello` (or your configured trigger)
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check `SIGNAL_PHONE_NUMBER` is set in `.env` AND synced to `data/env/env`
2. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'signal:%'"`
3. For non-main chats: message must include trigger pattern
4. Service is running: check process or service status
5. signal-cli health: `signal-cli -a +PHONE receive --timeout 5`

### signal-cli crashes or hangs

1. Check Java version: `java --version` (must be 21+)
2. Check linked device status: open Signal app → Settings → Linked Devices
3. Re-link if device was removed: repeat the `signal-cli link` step
4. Check signal-cli data directory permissions: `ls -la ~/.local/share/signal-cli/`

### "signal-cli failed to become healthy"

The health check waits 60 seconds for signal-cli to respond to a `version` RPC call. If this times out:
1. Try running signal-cli manually: `signal-cli -a +PHONE -o json jsonRpc`
2. Check for Java errors in stderr output
3. Ensure the phone number matches the linked account

### Messages not arriving

1. Verify signal-cli receives messages: `signal-cli -a +PHONE receive --timeout 30`
2. Check the JID format matches exactly what `/chatid` reported
3. For groups: group ID is base64-encoded, must match exactly
