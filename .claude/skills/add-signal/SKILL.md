---
name: add-signal
description: Add Signal as a messaging channel. Uses linked-device authentication (QR code scan from your phone). Primary use case is "Note to Self" personal assistant.
---

# Add Signal Channel

Add Signal as a messaging channel for NanoClaw. Supports two modes:

- **Linked device** — Shares your existing Signal account. Best for "Note to Self" personal assistant.
- **Primary device** — Registers a separate phone number as the bot's own identity. Best for group chats where the bot appears as its own user.

**Prerequisites:**
- Java 25+ installed (macOS: `brew install openjdk`, signal-cli requires class file version 69.0)
- Signal app on your phone (linked mode) or a phone number that can receive one SMS (primary mode)

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

Also check for credentials:
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

## Phase 3: Choose Mode

AskUserQuestion: How do you want to use Signal with NanoClaw?

- **Note to Self (linked device)** — Links to your existing Signal account. You message yourself in "Note to Self" and the agent responds. Quick setup — just scan a QR code. The bot shares your identity.
- **Own identity (primary device)** — Registers a separate phone number as the bot's account. The bot appears as its own contact in group chats. Needs a phone number that can receive one SMS for verification (cheap prepaid SIM or eSIM works, only needed once).

### Mode A: Linked Device

#### Get phone number

AskUserQuestion: What is the phone number for your Signal account? (E.164 format, e.g. +447700900000)

Write `SIGNAL_PHONE_NUMBER=<number>` to `.env`.

#### Link device

```bash
npx tsx setup/index.ts --step signal-auth --mode linked
```

This displays a QR code — user scans it from Signal: **Settings > Linked Devices > Link New Device**.

Wait for confirmation (`SIGNAL_AUTH_OK=true`). The timeout is 120 seconds. If it fails, retry.

### Mode B: Primary Device

#### Get phone number

AskUserQuestion: What phone number will the bot use? (E.164 format, e.g. +447700900000). This must be a number that can receive one SMS for verification. After registration, the SIM is no longer needed.

Write `SIGNAL_PHONE_NUMBER=<number>` to `.env`.

#### Register

```bash
npx tsx setup/index.ts --step signal-auth --mode primary
```

This sends a verification SMS to the number.

**If captcha required:** The output will show `STATUS=captcha_required` and a URL. AskUserQuestion: Signal requires a captcha. Open the URL shown above in a browser, complete the captcha, and paste the `signalcaptcha://` token here.

Then re-run with the captcha token:
```bash
npx tsx setup/index.ts --step signal-auth --captcha "<token>"
```

This re-sends the SMS. Then proceed to verify.

#### Verify

AskUserQuestion: Enter the 6-digit verification code from the SMS.

```bash
npx tsx setup/index.ts --step signal-auth --verify <code>
```

Wait for `SIGNAL_AUTH_OK=true`. This also sets the bot's profile name to the ASSISTANT_NAME value (default "Andy").

**Credentials location:** After successful registration, signal-cli stores credentials at `~/.local/share/signal-cli/data/`. This is a standard XDG path and works regardless of where NanoClaw is installed (internal or external drive).

## Phase 4: Registration

### For linked device (Note to Self)

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

### For primary device (own identity)

Register the bot's own number. Users will DM the bot or add it to groups:

```bash
npx tsx setup/index.ts --step register \
  --jid "signal:+<SIGNAL_PHONE_NUMBER>" \
  --name "Signal Bot" \
  --trigger "@Andy" \
  --folder signal_bot \
  --channel signal \
  --is-main \
  --no-trigger-required
```

To add the bot to Signal groups: add the bot's phone number as a contact on Signal, then add it to groups like any other member. Messages in registered groups will trigger the agent.

### How "Note to Self" works (linked mode)

Signal's "Note to Self" is a chat where you message yourself. When you type a message on your phone:
- It arrives as a `syncMessage.sentMessage` (synced from your phone to the linked device)
- The destination is your own phone number
- NanoClaw detects this as a user message (no `ASSISTANT_NAME:` prefix) and routes it to the agent

When the agent replies:
- NanoClaw sends the reply prefixed with the assistant name (e.g. "Andy: ...")
- This arrives back as a syncMessage too, but NanoClaw detects the prefix and marks it as a bot message (skips re-processing)

**Note:** In linked mode, NanoClaw only processes syncMessages destined for your own number (Note to Self). Messages you send in other groups or DMs are ignored — they won't trigger the bot.

### How primary mode works

The bot has its own Signal account. Incoming messages arrive as `dataMessage` events (not syncMessages). The bot can be added to groups as a regular member and responds with its own identity.

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
- Uses a named wrapper script (`~/.local/bin/nanoclaw`) instead of direct node execution
- Stores logs at `~/.local/share/nanoclaw/logs/` (local filesystem) with a symlink from the project's `logs/` directory
- This avoids macOS launchd's EX_CONFIG (exit 78) issue with external volumes

No special configuration is needed — the service step detects and handles this.

### Test

- **Linked mode:** Send a message in Signal "Note to Self". The agent should respond.
- **Primary mode:** Send a DM to the bot's phone number on Signal. The agent should respond.

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

**Captcha required (primary mode)**: Signal sometimes requires a captcha before registration. Follow the URL in the output, complete the challenge, and pass the token with `--captcha`.

**SMS not received (primary mode)**: Signal blocks many VoIP number ranges. A physical SIM or eSIM is most reliable. You can also try `--voice` verification (not yet implemented — use `signal-cli -u +NUMBER register -v` manually for voice call verification).

**Java not found / wrong version**: signal-cli requires Java 25+. macOS: `brew install openjdk`. The service step auto-detects Java from Homebrew (`/opt/homebrew/opt/openjdk/bin/java`) and sets `JAVA_HOME` in the launchd plist.

**Connection drops**: signal-sdk auto-reconnects. If persistent, check `~/.local/share/signal-cli/data/` permissions.

**launchd exit 78 on external drive**: The service step should handle this automatically. If it recurs, verify the plist uses a named wrapper and logs point to `~/.local/share/nanoclaw/logs/`.

**Messages not triggering agent**: Check the registered group JID matches `signal:+<number>`. Verify with: `npx tsx setup/index.ts --step verify`.

**Bot messages in other groups (linked mode)**: If messages you send in other Signal groups trigger the bot, the syncMessage filter may not be working. The channel should only process syncMessages destined for your own phone number. Check the `SIGNAL_PHONE_NUMBER` in `.env` matches exactly.
