---
name: add-signal
description: Add Signal as a channel. Can replace WhatsApp entirely or run alongside it. Requires signal-cli-rest-api as a companion service for phone registration and message routing.
---

# Add Signal Channel

This skill adds Signal support to NanoClaw using `signal-cli-rest-api` as a companion service. Signal has no official bot API, so this skill uses the open-source `signal-cli-rest-api` project which wraps the `signal-cli` Java tool and exposes a REST + WebSocket interface.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `signal` is in `applied_skills`, skip to Phase 3 (Service Setup). The code changes are already in place.

### Explain the architecture

Tell the user:

> **Signal integration requires a companion service** called `signal-cli-rest-api`.
> It handles Signal protocol communication and exposes a local REST/WebSocket API.
> NanoClaw connects to this service to send and receive messages.
>
> The easiest way to run it is with Docker Compose. I'll help you set it up.

### Ask the user

AskUserQuestion: Do you already have `signal-cli-rest-api` running, or do you need to set it up?

- **Set it up** (Recommended) - I'll generate a Docker Compose config and guide you through phone registration
- **Already running** - Skip straight to connecting NanoClaw

If already running, ask:

AskUserQuestion: What URL is your signal-cli-rest-api running at?
- **http://localhost:8080** (default)
- **Custom URL** - Provide the URL

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

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
- Adds `src/channels/signal.ts` (SignalChannel class with self-registration via `registerChannel`)
- Adds `src/channels/signal.test.ts` (unit tests)
- Appends `import './signal.js'` to the channel barrel file `src/channels/index.ts`
- Installs `ws` and `@types/ws` npm dependencies
- Updates `.env.example` with `SIGNAL_API_URL` and `SIGNAL_PHONE_NUMBER`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new signal tests) and build must be clean before proceeding.

## Phase 3: Service Setup

### If setting up signal-cli-rest-api

Tell the user:

> I'll create a `docker-compose.signal.yml` file for the signal-cli-rest-api service.
> This runs as a separate container alongside NanoClaw.

Create the file `docker-compose.signal.yml` in the project root:

```yaml
version: "3"
services:
  signal-cli-rest-api:
    image: bbernhard/signal-cli-rest-api:latest
    ports:
      - "8080:8080"
    volumes:
      - ./store/signal:/home/.local/share/signal-cli
    environment:
      - MODE=json-rpc
    restart: unless-stopped
```

Start the service:

```bash
docker compose -f docker-compose.signal.yml up -d
```

Wait ~10 seconds for the service to start, then verify:

```bash
curl -s http://localhost:8080/v1/about | head -c 200
```

If the response contains `{"versions":` the service is running.

### Register a phone number

Tell the user:

> You need a phone number for Signal. This can be:
> - A spare SIM card (recommended for dedicated use)
> - A VoIP number (e.g., Google Voice, Twilio) that can receive SMS

AskUserQuestion: How do you want to receive the Signal verification code?

- **SMS** (most common) - Get a text message with the verification code
- **Voice call** - Receive an automated call with the code

Ask for the phone number (with country code, e.g., `+19876543210`).

#### Request verification code

For SMS:
```bash
curl -X POST "http://localhost:8080/v1/register/+PHONENUMBER" \
  -H "Content-Type: application/json" \
  -d '{"use_voice": false}'
```

For voice call:
```bash
curl -X POST "http://localhost:8080/v1/register/+PHONENUMBER" \
  -H "Content-Type: application/json" \
  -d '{"use_voice": true}'
```

Wait for the user to receive the code.

#### Verify the code

```bash
curl -X POST "http://localhost:8080/v1/register/+PHONENUMBER/verify/VERIFICATION-CODE" \
  -H "Content-Type: application/json"
```

If successful, the response will be `{}` or `{"result": "ok"}`.

If verification fails with a captcha error, tell the user:

> Signal requires a captcha challenge. This usually happens when registering a new number frequently.
>
> 1. Open `https://signalcaptchas.org/registration/generate.html` in a browser
> 2. Complete the captcha — it will redirect to `signalcaptcha://...`
> 3. Copy the full `signalcaptcha://...` URL
>
> Then re-register with the captcha token:
> ```bash
> curl -X POST "http://localhost:8080/v1/register/+PHONENUMBER" \
>   -H "Content-Type: application/json" \
>   -d '{"use_voice": false, "captcha": "signalcaptcha://PASTE_TOKEN_HERE"}'
> ```

## Phase 4: Configure Environment

### Set environment variables

Add to `.env`:

```bash
SIGNAL_API_URL=http://localhost:8080
SIGNAL_PHONE_NUMBER=+PHONENUMBER
```

Channels auto-enable when their credentials are present.

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

## Phase 5: Registration

### Get the phone number to register

The JID for a Signal contact is `signal:+PHONENUMBER`.
The JID for a Signal group is `signal:group.BASE64GROUPID`.

For a direct message conversation with yourself (for testing):

```
signal:+YOURNUMBER
```

### Register the chat

For a main chat (responds to all messages):

```typescript
registerGroup("signal:+PHONENUMBER", {
  name: "Signal",
  folder: "signal_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

To find group IDs, send a message to a Signal group and watch the logs:

```bash
tail -f logs/nanoclaw.log | grep signal
```

The JID will appear as `signal:group.BASE64GROUPID`. Register it:

```typescript
registerGroup("signal:group.BASE64GROUPID", {
  name: "Group Name",
  folder: "signal_groupname",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 6: Verify

### Test the connection

Tell the user:

> Send a message to your registered Signal contact/group:
> - For main chat: Any message works
> - For trigger-required: Start with `@Andy` (or your trigger)
>
> The assistant should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### signal-cli-rest-api not starting

```bash
docker compose -f docker-compose.signal.yml logs
```

Common issues:
- Port 8080 already in use: change `"8080:8080"` to `"8081:8080"` and update `SIGNAL_API_URL`
- Docker not running: `systemctl start docker` or open Docker Desktop

### Registration failed

- Phone must be able to receive SMS/voice
- Number must not already be registered on another device
- If you see a captcha error, follow the captcha steps in Phase 3
- Rate limited: wait 1-2 hours before retrying

### Messages not arriving

Check:
1. `SIGNAL_API_URL` is reachable: `curl -s $SIGNAL_API_URL/v1/about`
2. `SIGNAL_PHONE_NUMBER` matches the registered number (include `+` and country code)
3. Both variables are in `.env` AND synced to `data/env/env`
4. Chat is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'signal:%'"`
5. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### WebSocket keeps reconnecting

The channel reconnects automatically on disconnect. If it reconnects continuously:
1. Check signal-cli-rest-api is running: `docker compose -f docker-compose.signal.yml ps`
2. Check the API URL is correct in `.env`
3. Look at `docker compose -f docker-compose.signal.yml logs --tail=50`

### Finding group IDs

Send a message to the group while NanoClaw is running. Look in the logs:

```bash
grep "unregistered Signal chat" logs/nanoclaw.log
```

The JID in the log is what you need to register.

## After Setup

If running `npm run dev` while the service is active:

```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist

# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove Signal integration:

1. Delete `src/channels/signal.ts` and `src/channels/signal.test.ts`
2. Remove `import './signal.js'` from `src/channels/index.ts`
3. Remove `SIGNAL_API_URL` and `SIGNAL_PHONE_NUMBER` from `.env`
4. Remove Signal registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'signal:%'"`
5. Uninstall: `npm uninstall ws @types/ws`
6. Stop the service: `docker compose -f docker-compose.signal.yml down`
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
