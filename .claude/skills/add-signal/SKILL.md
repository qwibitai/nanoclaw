---
name: add-signal
description: Add Signal as a channel via signal-cli daemon. Can replace WhatsApp entirely or run alongside it. Uses TCP JSON-RPC with zero npm dependencies.
---

# Add Signal Channel

This skill adds Signal support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

Signal requires an external `signal-cli` daemon (Java). NanoClaw connects to it over TCP (JSON-RPC) — no npm dependency needed.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `signal` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Should Signal replace WhatsApp or run alongside it?
- **Replace WhatsApp** - Signal will be the only channel (sets SIGNAL_ONLY=true)
- **Alongside** - Both Signal and WhatsApp channels active

AskUserQuestion: Do you have signal-cli installed and a phone number registered, or do you need to set that up?

If they're ready, collect the phone number and daemon URL now. If not, we'll set it up in Phase 3.

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
- Adds `src/channels/signal.ts` (SignalChannel class implementing Channel interface, TCP JSON-RPC)
- Adds `src/channels/signal.test.ts` (unit tests)
- Three-way merges Signal support into `src/index.ts` (multi-channel support, findChannel routing)
- Three-way merges Signal config into `src/config.ts` (SIGNAL_PHONE_NUMBER, SIGNAL_CLI_URL, SIGNAL_ONLY)
- Three-way merges updated routing tests into `src/routing.test.ts`
- No npm dependency to install (uses Node.js `net` module)
- Updates `.env.example` with `SIGNAL_PHONE_NUMBER`, `SIGNAL_CLI_URL`, and `SIGNAL_ONLY`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup

### Install signal-cli (if needed)

Tell the user:

> signal-cli requires **Java 21+**. Then install signal-cli itself:
>
> **Important:** If you have `JAVA_HOME` set to an older Java version (e.g., Java 17), signal-cli will fail. Either `unset JAVA_HOME` or point it to a Java 21+ installation before running signal-cli commands.
>
> **macOS (Homebrew):**
> ```bash
> brew install signal-cli
> ```
>
> **Linux / manual:**
> Download the latest release from https://github.com/AsamK/signal-cli/releases
> Extract and add to PATH.
>
> Verify: `signal-cli --version`

### Register a phone number (if needed)

Tell the user:

> You need a dedicated phone number for the bot. This can be a prepaid SIM, Google Voice, or Twilio number. **Registering as primary device will de-authenticate the Signal app on that phone.**
>
> Alternative: **link as a secondary device** to keep using Signal on your phone (see below).
>
> **Primary registration:**
> 1. Get a CAPTCHA token: visit `https://signalcaptchas.org/registration/generate.html` in your browser, solve it, copy the `signalcaptcha://` URL
> 2. Register: `signal-cli -a +YOUR_NUMBER register --captcha "signalcaptcha://..."`
> 3. Enter verification code: `signal-cli -a +YOUR_NUMBER verify CODE`
>
> **Linked device (no separate number needed):**
> 1. Run: `signal-cli link -n "NanoClaw"` — this prints a `tsdevice:` URI
> 2. Convert to QR code: `qrencode -t ANSI "tsdevice://..."`
> 3. Scan with Signal app: Settings > Linked Devices > Link New Device
>
> **Note:** The link URI expires after ~60 seconds. If linking fails, re-run the `link` command for a fresh URI.

Wait for the user to confirm registration.

### Start the signal-cli daemon

Tell the user:

> Start the daemon in TCP mode (keep it running):
> ```bash
> signal-cli -a +YOUR_NUMBER daemon --tcp localhost:7583
> ```
>
> **Important:** Use `--tcp` (not `--http`). The HTTP mode does not support receiving messages — only TCP provides bidirectional JSON-RPC for both sending and receiving.
>
> For production, consider running it as a systemd/launchd service. I can help set that up.

### Configure environment

Add to `.env`:

```bash
SIGNAL_PHONE_NUMBER=+YOUR_NUMBER
SIGNAL_CLI_URL=localhost:7583
```

If they chose to replace WhatsApp:

```bash
SIGNAL_ONLY=true
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> **Easiest method:** Send `/chatid` in any Signal chat with the bot. It will reply with the JID.
>
> **For 1:1 chats:** The JID is the phone number with `sig:` prefix, e.g., `sig:+1234567890`
>
> **For group chats:** Get the group ID:
> ```bash
> signal-cli -a +YOUR_NUMBER listGroups
> ```
> The JID format is `sig:g:<groupId>`, e.g., `sig:g:ABC123base64==`
>
> **Note to Self:** Register your own number's JID (e.g., `sig:+YOUR_NUMBER`) to use Signal's "Note to Self" as a private chat with the bot. Messages you send there are treated as user input, not bot echoes.

Wait for the user to provide the chat JID.

### Register the chat

For a main chat (responds to all messages, uses the `main` folder):

```typescript
registerGroup("sig:<jid>", {
  name: "<chat-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("sig:<jid>", {
  name: "<chat-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

Tell the user:

> Send a message to your registered Signal chat. The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check signal-cli daemon is running: `nc -z localhost 7583` or `echo '{"jsonrpc":"2.0","id":1,"method":"listAccounts","params":{}}' | nc localhost 7583`
2. Check `.env` has `SIGNAL_PHONE_NUMBER` and `SIGNAL_CLI_URL`, AND synced to `data/env/env`
3. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'sig:%'"`
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### signal-cli daemon won't start

- Ensure Java 21+: `java -version`
- If `JAVA_HOME` is set, verify it points to Java 21+: `$JAVA_HOME/bin/java -version`. Either `unset JAVA_HOME` or update it.
- Ensure number is registered: `signal-cli -a +NUMBER receive` (should not error)
- Check for port conflicts: `lsof -i :7583`

### Linked device setup fails

- The `signal-cli link` URI expires after ~60 seconds. Re-run the command for a fresh URI.
- Ensure your phone has Signal installed and can reach the internet.
- After linking, verify the device is registered: `signal-cli -a +NUMBER listDevices`

### No messages received after connecting

- Verify the daemon was started with `--tcp` (not `--http`). The HTTP mode is send-only.
- NanoClaw automatically calls `subscribeReceive` on connect. Check logs for subscription errors.
- "Note to Self" messages arrive as sync messages. The channel handles these correctly — if they're not working, check the daemon log output for `Received a sync message`.

## Removal

1. Delete `src/channels/signal.ts` and `src/channels/signal.test.ts`
2. Remove `SignalChannel` import and creation from `src/index.ts`
3. Remove Signal config from `src/config.ts`
4. Remove Signal registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'sig:%'"`
5. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)
