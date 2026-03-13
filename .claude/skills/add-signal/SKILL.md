---
name: add-signal
description: Add Signal as a messaging channel. Uses linked-device authentication (QR code scan from your phone). Primary use case is "Note to Self" personal assistant.
---

# Add Signal Channel

Add Signal as a messaging channel for NanoClaw. Uses linked-device authentication (QR code scan from your phone).

**Prerequisites:**
- Java 17+ installed (macOS only — `brew install openjdk`)
- Signal app on your phone

## Phase 1: Pre-flight

### Check Java (macOS only)

```bash
java -version 2>&1 | head -1 || echo "JAVA_MISSING"
```

If missing on macOS: `brew install openjdk`

### Check if already configured

```bash
test -d store/signal && test -n "$SIGNAL_PHONE_NUMBER" && echo "ALREADY_CONFIGURED" || echo "NEEDS_SETUP"
```

If already configured, skip to Phase 4 (Verify).

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

Write `SIGNAL_PHONE_NUMBER=<number>` to `.env`.

### Link device

Run device linking:

```bash
npx tsx setup/index.ts --step signal-auth
```

This displays a QR code in the terminal. User scans it from Signal: **Settings > Linked Devices > Link New Device**.

Wait for confirmation (`SIGNAL_AUTH_OK=true`). If it fails, retry.

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

**"Signal: not configured"**: Ensure `SIGNAL_PHONE_NUMBER` is set in `.env` and `store/signal/` exists with credentials.

**Device linking timeout**: You have 90 seconds to scan the QR code. Re-run the auth step.

**Java not found**: Install Java 17+. macOS: `brew install openjdk`. The setup step checks for this.

**Connection drops**: signal-sdk auto-reconnects. If persistent, check `store/signal/` permissions and signal-cli logs.
