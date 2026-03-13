---
name: add-signal
description: Add Signal as a messaging channel. Uses linked-device authentication (QR code scan from your phone). Primary use case is "Note to Self" personal assistant.
---

# Add Signal Channel

Add Signal as a messaging channel for NanoClaw. Uses linked-device authentication (QR code scan from your phone).

**Prerequisites:**
- Java 25+ installed (macOS: `brew install openjdk`, signal-cli requires class file version 69.0)
- Signal app on your phone

## Phase 1: Pre-flight

### Check Java (macOS only)

```bash
java -version 2>&1 | head -1 || echo "JAVA_MISSING"
```

If missing on macOS: `brew install openjdk`

**Important:** signal-cli requires Java 25+ (class file version 69.0). The Homebrew `openjdk` formula provides this. System Java from older macOS versions may not be sufficient.

### Check if already configured

```bash
test -n "$SIGNAL_PHONE_NUMBER" && echo "ALREADY_CONFIGURED" || echo "NEEDS_SETUP"
```

Also check for linked device credentials:
```bash
ls ~/.local/share/signal-cli/data/ 2>/dev/null | head -5 || echo "NO_CREDENTIALS"
```

If both phone number and credentials exist, skip to Phase 4 (Verify).

### Check signal-sdk is installed

```bash
node -e "require('signal-sdk')" 2>/dev/null && echo "SDK_OK" || echo "SDK_MISSING"
```

If missing: `npm install signal-sdk && npm run build`

## Phase 2: Code Installation

Signal channel is built into NanoClaw core. If `src/channels/signal.ts` exists, skip this phase.

If missing, you're on an older version. Run `/update-nanoclaw` to get the Signal channel.

## Phase 3: Authentication (Device Linking)

### Get phone number

AskUserQuestion: What is the phone number for your Signal account? (E.164 format, e.g. +447700900000)

Virtual numbers (e.g. Google Voice, Twilio) work if they can receive SMS for initial Signal registration. The linked device itself doesn't need SMS capability.

Write `SIGNAL_PHONE_NUMBER=<number>` to `.env`.

### Link device

Run device linking:

```bash
npx tsx setup/index.ts --step signal-auth
```

This displays a QR code in the terminal. User scans it from Signal: **Settings > Linked Devices > Link New Device**.

Wait for confirmation (`SIGNAL_AUTH_OK=true`). The timeout is 120 seconds. If it fails, retry.

**Credentials location:** After successful linking, signal-cli stores credentials at `~/.local/share/signal-cli/data/`. This is a standard XDG path and works regardless of where NanoClaw is installed (internal or external drive).

## Phase 4: Registration

Register "Note to Self" as the main channel:

```bash
npx tsx setup/index.ts --step register \
  --jid "signal:+<SIGNAL_PHONE_NUMBER>" \
  --name "Signal Main" \
  --trigger "@Andy" \
  --folder signal_main \
  --channel signal \
  --is-main \
  --no-trigger-required
```

Replace `<SIGNAL_PHONE_NUMBER>` with the actual number from `.env`.

### How "Note to Self" works

Signal's "Note to Self" is a chat where you message yourself. When you type a message on your phone:
- It arrives as a `syncMessage.sentMessage` (synced from your phone to the linked device)
- The destination is your own phone number
- NanoClaw detects this as a user message (no `ASSISTANT_NAME:` prefix) and routes it to the agent

When the agent replies:
- NanoClaw sends the reply prefixed with the assistant name (e.g. "Andy: ...")
- This arrives back as a syncMessage too, but NanoClaw detects the prefix and marks it as a bot message (skips re-processing)

## Phase 5: Verify

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Or on Linux:
```bash
npm run build
systemctl --user restart nanoclaw
```

### External drive note

NanoClaw's service step (`setup/service.ts`) handles external/network drive installations automatically:
- Uses a bash wrapper (`cd <path> && exec node ...`) instead of `WorkingDirectory` in the plist
- Stores logs at `~/.local/share/nanoclaw/logs/` (local filesystem) with a symlink from the project's `logs/` directory
- This avoids macOS launchd's EX_CONFIG (exit 78) issue with external volumes

No special configuration is needed — the service step detects and handles this.

### Test

Send a message in Signal "Note to Self". The agent should respond.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i signal
```

Look for:
- `Signal: connected` — successful connection
- `Signal: message sent` — bot replied
- `Signal: voice transcribed` — voice transcription working

## Troubleshooting

**"Signal: not configured"**: Ensure `SIGNAL_PHONE_NUMBER` is set in `.env`. Credentials are stored at `~/.local/share/signal-cli/data/`, not in the project directory.

**Device linking timeout**: You have 120 seconds to scan the QR code. Re-run the auth step.

**Java not found / wrong version**: signal-cli requires Java 25+. macOS: `brew install openjdk`. The service step auto-detects Java from Homebrew (`/opt/homebrew/opt/openjdk/bin/java`) and sets `JAVA_HOME` in the launchd plist.

**Connection drops**: signal-sdk auto-reconnects. If persistent, check `~/.local/share/signal-cli/data/` permissions.

**launchd exit 78 on external drive**: The service step should handle this automatically. If it recurs, verify the plist uses a bash wrapper (not `WorkingDirectory`) and logs point to `~/.local/share/nanoclaw/logs/`.

**Messages not triggering agent**: Check the registered group JID matches `signal:+<your_number>`. For Note to Self, the JID must be your own phone number. Verify with: `npx tsx setup/index.ts --step verify`.
