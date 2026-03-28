---
name: add-local-chat
description: Add embedded HTTP + WebSocket chat server with PWA. Enables a local web chat interface for NanoClaw on port 3100.
---

# Add Local Chat Server

This skill adds an in-process chat server to NanoClaw with a lightweight PWA frontend, then walks through setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/chat-server.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

## Phase 2: Apply Code Changes

### Fetch and merge the skill branch

```bash
git fetch origin skill/local-chat
git merge origin/skill/local-chat || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

This merges in:
- `src/chat-server.ts` (HTTP + WebSocket server, disabled by default)
- `src/chat-db.ts` (SQLite persistence for rooms and messages)
- `chat-pwa/` directory (PWA frontend: HTML, JS, CSS, service worker, manifest)
- `ws` npm dependency in `package.json`
- `import { startChatServer, stopChatServer }` added to `src/index.ts`
- `await startChatServer()` call in the main startup sequence
- `CHAT_SERVER_ENABLED` and `CHAT_SERVER_PORT` in `.env.example`

### Validate code changes

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Configure environment

The chat server is disabled by default. To enable it, add to `.env`:

```bash
CHAT_SERVER_ENABLED=true
CHAT_SERVER_PORT=3100        # optional, default 3100
CHAT_SERVER_HOST=127.0.0.1   # optional, default localhost only
```

### Network access & authentication

Ask the user: **"Should the chat server be accessible from other devices on your network, or only from this machine?"**

If **localhost only** (default): no further configuration needed. Skip to syncing the env.

If **network accessible** (`0.0.0.0`): **authentication must be configured first**. Ask the user which authentication method(s) they want:

1. **Bearer token** (recommended) — a shared secret that remote clients must provide. Simple and works everywhere.
2. **Tailscale only** — restrict to devices on the user's tailnet. Zero-config for tailscale users, but requires tailscale to be running.
3. **Both** (most secure) — Tailscale peers get in automatically, all other remote connections need the token.

Then configure based on their choice:

#### Option 1: Bearer token

Generate a secure random token:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

Add to `.env`:

```bash
CHAT_SERVER_HOST=0.0.0.0
CHAT_SERVER_TOKEN=<generated-token>
```

Tell the user to save the token — they'll need it when connecting from other devices. The PWA will show a login screen where they enter it.

#### Option 2: Tailscale only

Ensure tailscale is running and `/var/run/tailscale/tailscaled.sock` is accessible. Add to `.env`:

```bash
CHAT_SERVER_HOST=0.0.0.0
```

No token is needed — the server authenticates via tailscale whois. Non-tailscale remote connections will be rejected.

**Important:** Without `CHAT_SERVER_TOKEN` set and without tailscale, the server will log a warning and allow unauthenticated remote connections. Always configure at least one auth method when binding to 0.0.0.0.

#### Option 3: Both (recommended for 0.0.0.0)

Generate a token as in Option 1, and ensure tailscale is running. Add to `.env`:

```bash
CHAT_SERVER_HOST=0.0.0.0
CHAT_SERVER_TOKEN=<generated-token>
```

Tailscale peers authenticate automatically. Other remote clients use the token.

### Sync environment

```bash
mkdir -p data/env && cp .env data/env/env
```

### Add to systemd service (Linux)

If running as a systemd service, add the environment variables:

```bash
# Check current service file
systemctl --user cat nanoclaw
```

Add the variables that match the chosen configuration:

```ini
Environment=CHAT_SERVER_ENABLED=true
Environment=CHAT_SERVER_HOST=0.0.0.0          # only if network accessible
Environment=CHAT_SERVER_TOKEN=<token>          # only if using token auth
```

Then reload and restart:

```bash
systemctl --user daemon-reload
systemctl --user restart nanoclaw
```

### Add to launchd plist (macOS)

If running as a launchd service, add to the `EnvironmentVariables` dict in `~/Library/LaunchAgents/com.nanoclaw.plist`:

```xml
<key>CHAT_SERVER_ENABLED</key>
<string>true</string>
<key>CHAT_SERVER_HOST</key>
<string>0.0.0.0</string>
<!-- Only if using token auth -->
<key>CHAT_SERVER_TOKEN</key>
<string>your-token-here</string>
```

Then restart:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Register Main Group

The local chat server needs a room registered as the **main NanoClaw group** so the primary bot instance (not a sub-agent) is connected. This gives it elevated privileges: no trigger word required, ability to manage other groups, and full IPC access.

### Check for existing main group

```bash
npx tsx -e "
import { initDatabase, getAllRegisteredGroups } from './src/db.ts';
initDatabase();
const groups = getAllRegisteredGroups();
const main = groups.find(g => g.isMain);
if (main) console.log('EXISTING_MAIN=' + main.folder + ' JID=' + Object.entries(groups).find(([,v]) => v === main)?.[0]);
else console.log('NO_MAIN');
"
```

If a main group already exists on another channel (e.g. `whatsapp_main`), ask the user whether they want to:
1. **Keep the existing main** and register the local-chat room as a regular (sub-agent) group
2. **Move the main to local-chat** (the old main becomes a regular group)

### Ask the user to choose a room name

Present these options for the main control room:

1. `control` — "Control Room" (recommended — clear purpose)
2. `bridge` — "Bridge" (Star Trek inspired)
3. `main` — "Main" (simple and direct)
4. Custom — let the user type their own

### Create the room and register

Once the user picks a name (e.g. `control`), create the chat room and register it as the main group:

```bash
# Read assistant name from .env
ASSISTANT_NAME=$(grep '^ASSISTANT_NAME=' .env | sed 's/ASSISTANT_NAME=//;s/"//g' || echo "Andy")
TRIGGER="@${ASSISTANT_NAME}"

npx tsx setup/index.ts --step register \
  --jid "chat:<room_id>" \
  --name "<room_name>" \
  --trigger "$TRIGGER" \
  --folder "chat_<room_id>" \
  --channel local-chat \
  --assistant-name "$ASSISTANT_NAME" \
  --is-main \
  --no-trigger-required
```

Replace `<room_id>` and `<room_name>` with the user's choice (e.g. `control` / `Control Room`).

### Seed the room in chat-db

The room must also exist in the chat database so it appears in the PWA. Add it to the seed list in `src/chat-db.ts` if it's not already one of the defaults, OR create it via the API:

```bash
curl -X POST http://127.0.0.1:3100/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"id":"<room_id>","name":"<room_name>"}'
```

### Restart the service

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

After restart, the main NanoClaw instance will be connected to the chosen room. Messages sent there are processed without a trigger word, and the bot has full control privileges.

## Phase 5: Verify

### Test main group registration

Send a message in the control room via the PWA. The main NanoClaw bot should respond without needing a trigger word. The member panel should show the bot as an active member while processing.

### Test the server

```bash
curl http://127.0.0.1:3100/health
```

Expected response: `{"ok":true}`

### Test the PWA

Open `http://127.0.0.1:3100/` in a browser. The chat interface should load.

### Test WebSocket

```bash
npx wscat -c ws://127.0.0.1:3100/ws
```

### Check logs

```bash
grep "Chat server" logs/nanoclaw.log
```

Should show: `Chat server started`

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Serves PWA |
| `/health` | GET | Health check |
| `/api/rooms` | GET | List rooms |
| `/api/rooms` | POST | Create room |
| `/api/rooms/:id/messages` | GET | Message history |
| `/api/agents` | GET | List agent tokens |
| `/api/agents` | POST | Create agent token |
| `/ws` | WS | WebSocket chat |

## Troubleshooting

### Server not starting

1. Check `CHAT_SERVER_ENABLED=true` is in the process environment (not just `.env`):
   ```bash
   cat /proc/$(pgrep -f "dist/index.js")/environ | tr '\0' '\n' | grep CHAT
   ```
2. If using systemd, ensure `daemon-reload` was run after editing the service file
3. Check logs: `grep -i "chat" logs/nanoclaw.log`

### Port already in use

Change the port via `CHAT_SERVER_PORT` in `.env` and the service environment.

### Can't access from another device

By default, the server binds to `127.0.0.1` (localhost only). To allow LAN access, set `CHAT_SERVER_HOST=0.0.0.0` — but be aware this exposes the chat server to your network.
