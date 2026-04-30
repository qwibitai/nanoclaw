---
name: add-webchat-v1
description: Add embedded HTTP + WebSocket chat server with PWA to NanoClaw v1.x.x. Enables a webchat interface on port 3100. Targets v1 only — for v2, use add-webchat-v2.
---

# Add Webchat Server (NanoClaw v1)

This skill adds an in-process chat server to NanoClaw with a lightweight PWA frontend, then walks through setup.

**Target version:** NanoClaw **v1.x.x** (single-file `src/db.ts`, flat DB schema). For v2 installs (with `src/db/` directory and central-DB schema), use `add-webchat-v2` instead — they are not interchangeable.

## Phase 1: Pre-flight

### Check NanoClaw version

```bash
node -e "console.log(require('./package.json').version)"
```

If the major version is **2** or higher, **stop**. This skill targets v1 only. Tell the user to use `add-webchat-v2` instead.

### Check if already applied

Check if `src/chat-server.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

## Phase 2: Apply Code Changes

### Fetch and merge the skill branch

```bash
git fetch origin skill/webchat-v1
git merge origin/skill/webchat-v1 || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

This merges in:
- `src/chat-server.ts` (HTTP server boot + REST routes for rooms/bots/agents/tasks, disabled by default)
- `src/chat-server/` directory:
    - `auth.ts` (bearer token / Tailscale whois / trusted-proxy header authentication)
    - `state.ts` (in-memory client registry, broadcast, presence, channel-adapter hooks)
    - `ws.ts` (WebSocket setup + AUTH/JOIN/TYPING/MESSAGE/DELETE_MESSAGE handlers)
    - `push.ts` (VAPID init + Web Push fan-out for offline devices)
    - `files.ts` (multipart upload, chunked upload, file-serve routes)
- `src/chat-db.ts` (SQLite persistence for rooms, messages, push subscriptions, agent tokens)
- `src/redact.ts` (sensitive-data masking for chat-server logs)
- `src/timezone.ts` (IANA timezone helpers)
- `src/channels/webchat.ts` (channel adapter that registers the webchat channel)
- `chat-pwa/` directory (PWA frontend: HTML, JS, CSS, service worker, manifest)
- `import './webchat.js'` added to `src/channels/index.ts`
- `import { startChatServer, stopChatServer, setOnGroupUpdated }` and corresponding lifecycle calls added to `src/index.ts`
- Four db functions (`updateRegisteredGroup`, `deleteRegisteredGroup`, `logMessageRoute`, `getMessageRoutes`) and a `message_routes` table added to `src/db.ts`
- `readClaudeAiOauthToken()` in `src/container-runner.ts` — reads the host Claude Code credentials file (`~/.claude/.credentials.json` or `$CLAUDE_CONFIG_DIR/.credentials.json`) on every container spawn and prefers it over `.env`. Keeps the OAuth token fresh without NanoClaw running its own refresh flow. See "Claude authentication" → Option 1 in Phase 3.
- npm dependencies: `ws`, `busboy`, `web-push` (plus their `@types/*`) in `package.json`
- `@onecli-sh/sdk` as an **optional** dependency (only loaded at runtime if `ONECLI_URL` is set — see Phase 3 → "Optional: OneCLI credential proxy")
- `CHAT_SERVER_*`, `TLS_*`, and `ONECLI_*` keys in `.env.example`

### Validate code changes

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Claude authentication

Agent containers need to call Anthropic's API. **Use `AskUserQuestion`** to present the trade-offs and let the user pick. Frame the choice up-front in the question text:

> "**Claude Code session** is the easiest — zero setup if you already use Claude Code on this machine, and the runtime auto-reads `~/.claude/.credentials.json` on every container spawn so the token never goes stale (the host `claude` CLI handles OAuth refresh). **OneCLI** is the most secure — credentials never enter the container."

Default to **Claude Code session** for ease and call out OneCLI as the most secure upgrade path. List the Claude Code session option first in the `AskUserQuestion` options array and append `(Recommended)` to its label.

| Option | Pros | Cons |
|--------|------|------|
| **1. Claude Code session (host credentials file)** *(default — easiest)* | • Zero extra steps if `claude` is installed and logged in on the host.<br>• Auto-refreshing: `src/container-runner.ts` reads `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`) on every container spawn. Host `claude` CLI handles OAuth refresh; NanoClaw rides along.<br>• Validates `expiresAt` with a 30s buffer; logs a `warn` and falls through to `.env` if the host token is expired.<br>• Survives Claude Code rotations transparently — no `.env` edits, no service restarts. | Requires Claude Code installed + logged in on the host. If you `claude logout`, NanoClaw also loses access until you log back in. |
| **2. OneCLI credential gateway** *(most secure)* | • Token never lands on disk for the container — gateway injects it per-request; even a malicious tool call inside the container has nothing to steal.<br>• Per-agent identities — scope which secrets each agent group can use.<br>• Audit log of every credentialed request.<br>• One-shot rotation: rotate a key in the vault and every agent picks it up on the next request — no `.env` editing, no service restart.<br>• Approval gating — server-side rules that hold a credentialed request for human approval before it goes through (e.g. "ask me before any write to the GitHub API").<br>• One config covers many integrations (Anthropic, Gmail, Calendar, GitHub, etc.) as you add them later. | Extra service to install and run. One more moving part to debug. Overkill for a single-user, single-machine, single-integration install. |
| **3. Static `CLAUDE_CODE_OAUTH_TOKEN` in `.env`** | Works without Claude Code installed on the host. Dedicated token for NanoClaw, independent of any Claude Code session. | **Will rotate stale.** Tokens minted via `claude setup-token` lack the `user:profile` scope the SDK probes at startup, so once the original rotates you get `403`s and `error_during_execution`. Long-lived token sits in `.env`. The host-credentials path (Option 1) is strictly better whenever Claude Code is available. |
| **4. Anthropic API key** | Pay-per-use, separate billing, easy to revoke. Doesn't expire. | No subscription discount. Token in `.env`. |

Then configure based on the choice:

#### Option 1: Claude Code session (default)

Confirm `claude` is installed on the host and the credentials file exists:

```bash
test -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" \
  && jq -e '.claudeAiOauth.accessToken' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" >/dev/null \
  && echo "OK" \
  || { echo "Missing or empty Claude Code credentials — install claude and run \`claude\` once to log in, or pick a different option"; exit 1; }
```

That's it — no `.env` edits needed. `src/container-runner.ts` reads the credentials file on every container spawn (after the patches in this skill branch land), so the token stays fresh as long as the host `claude` CLI keeps it refreshed.

If `$CLAUDE_CONFIG_DIR` is set in the host environment, the runtime checks `$CLAUDE_CONFIG_DIR/.credentials.json` first, then falls back to `~/.claude/.credentials.json`. The runtime also validates `expiresAt` with a 30-second buffer and falls through to `.env` if the token is expired or missing — so this option pairs cleanly with Option 3 or 4 as a fallback.

#### Option 2: OneCLI credential gateway

If OneCLI isn't installed yet, point the user at the prod fork's `/init-onecli` skill (or the manual installer at <https://onecli.sh>). The OneCLI gateway service is out of scope for this skill — only the wiring to it is.

Once the gateway is running, set:

```bash
ONECLI_URL=http://172.17.0.1:10254
# ONECLI_API_KEY=<gateway-api-key>   # only if your gateway requires auth
```

The `@onecli-sh/sdk` package ships as an optional dependency — `npm install` picks it up automatically. The integration is lazy-loaded: if `ONECLI_URL` is unset, the SDK is never imported and behavior is identical to upstream NanoClaw v1.2.0. If the gateway is unreachable at runtime, the container falls back to env-var auth (if set) or the request fails.

After setting `ONECLI_URL`, register the agent with the gateway and assign secrets — see the OneCLI docs for exact steps. **Watch out** for the default `selective` secret mode: a freshly-registered agent gets *no* secrets assigned by default. Either flip the agent to `mode all` (every vault secret with a matching host pattern is injected) or assign specific secret IDs:

```bash
onecli agents list                                  # find agent id
onecli agents set-secret-mode --id <agent-id> --mode all
# or:
onecli secrets list                                 # find secret ids
onecli agents set-secrets --id <agent-id> --secret-ids <id1>,<id2>
```

The symptom of this gotcha is a `401 Unauthorized` from Anthropic even though the token is in the vault and the proxy is wired correctly.

#### Option 3: Static `CLAUDE_CODE_OAUTH_TOKEN` in `.env`

Tell the user to run `claude setup-token` in another terminal — do **not** collect the token in chat. Once they have it:

```bash
echo 'CLAUDE_CODE_OAUTH_TOKEN=<token-they-pasted>' >> .env
```

Warn the user that this token will rotate stale eventually (see the cons column above). Prefer Option 1 if Claude Code is available.

#### Option 4: Anthropic API key

Tell the user to create a key at <https://console.anthropic.com/settings/keys> and paste it. Then:

```bash
echo 'ANTHROPIC_API_KEY=<sk-ant-...>' >> .env
```

### Configure environment

The chat server is disabled by default. Enable it now:

```bash
# Check if already set
grep -q '^CHAT_SERVER_ENABLED=' .env 2>/dev/null || echo 'CHAT_SERVER_ENABLED=true' >> .env
```

This is required — the server will not start without `CHAT_SERVER_ENABLED=true` in `.env`.

### Generate VAPID keys for Web Push

Generate VAPID keys unconditionally during install. Without them, the PWA's first-load push-subscribe step hits `/api/push/vapid-public` and gets a `501`, which surfaces in the main window as `Push: server missing VAPID key (status 501)`. This confuses users into thinking the chat server is broken even though chat (WebSocket) works fine.

Generating the keys is local, takes ~1 second, has no external dependencies, and silences the 501 even when the user never enables push on a device. **Do this for every install.**

```bash
# Skip if already configured
if ! grep -q '^VAPID_PUBLIC_KEY=' .env 2>/dev/null; then
  VAPID_JSON=$(npx --yes web-push generate-vapid-keys --json)
  VAPID_PUBLIC=$(echo "$VAPID_JSON" | jq -r .publicKey)
  VAPID_PRIVATE=$(echo "$VAPID_JSON" | jq -r .privateKey)
  # Use git user email as VAPID subject; fall back to a generic mailto.
  VAPID_EMAIL=$(git config --get user.email 2>/dev/null || echo "admin@example.com")
  cat >> .env <<EOF
VAPID_PUBLIC_KEY=$VAPID_PUBLIC
VAPID_PRIVATE_KEY=$VAPID_PRIVATE
VAPID_SUBJECT=mailto:$VAPID_EMAIL
EOF
fi
```

If the user explicitly says they don't want Web Push, you can skip this — but the default behavior is to generate.

### Network access & authentication

**STOP — you must ask this before proceeding.** Use `AskUserQuestion` to ask:

**"Should the chat server be accessible from other devices on your network, or only from this machine?"**

Options:
1. **Localhost only** (recommended, most secure)
2. **Network accessible** (LAN/Tailscale/reverse proxy)

Do NOT skip this question or assume localhost.

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

**Important:** The server requires authentication for any non-localhost request. With `CHAT_SERVER_HOST=0.0.0.0` and no token, no tailscale, and no trusted proxy configured, remote connections will receive `401 Unauthorized`. Always configure at least one auth method when binding to 0.0.0.0.

##### Tailscale HTTPS (recommended for remote access)

Ask: **"Would you like to enable HTTPS via Tailscale? This is needed for browser features that require a secure context (microphone, geolocation, etc.) when accessing from another device — used by add-on skills like `/add-voice-dictation`."**

If yes:

1. Get the machine's Tailscale DNS name:

```bash
tailscale status --self --json | jq -r '.Self.DNSName' | sed 's/\.$//'
```

2. Generate TLS certificate (save the DNS name for the next steps):

```bash
mkdir -p data/tls && chmod 700 data/tls
sudo tailscale cert --cert-file data/tls/tailscale.crt --key-file data/tls/tailscale.key <DNS_NAME>
sudo chown $(id -u):$(id -g) data/tls/tailscale.crt data/tls/tailscale.key
chmod 600 data/tls/tailscale.key
```

3. Add to `.env`:

```bash
TLS_CERT=data/tls/tailscale.crt
TLS_KEY=data/tls/tailscale.key
```

4. Tell the user their access URL is now `https://<DNS_NAME>:3100` and that the certificate expires after 90 days. To renew, re-run the `tailscale cert` command above and restart the service.

If no, skip — the server will use plain HTTP. Secure-context browser features (mic, geolocation) will still work via `localhost`.

#### Option 3: Both (recommended for 0.0.0.0)

Generate a token as in Option 1, and ensure tailscale is running. Add to `.env`:

```bash
CHAT_SERVER_HOST=0.0.0.0
CHAT_SERVER_TOKEN=<generated-token>
```

Tailscale peers authenticate automatically. Other remote clients use the token.

Then follow the **Tailscale HTTPS** instructions under Option 2 above to enable HTTPS (required by secure-context browser features like microphone access used by add-on skills such as `/add-voice-dictation`).

#### Option 4: Trusted Proxy (Cloudflare, Azure/Entra ID, Authelia, Caddy, nginx, AWS ALB, Google IAP)

For users running behind a reverse proxy that handles authentication. The proxy authenticates the user and injects an identity header into the forwarded request. No PWA-side auth needed.

Ask for the proxy's IP address(es) (comma-separated) and the header name. Common header names by provider:

| Provider | Header |
|----------|--------|
| Default / Authelia / Authentik | `X-Forwarded-User` |
| Azure / Entra ID | `X-MS-CLIENT-PRINCIPAL-NAME` |
| Cloudflare Access | `Cf-Access-Authenticated-User-Email` |
| AWS ALB | `X-Amzn-Oidc-Identity` |
| Google IAP | `X-Goog-Authenticated-User-Email` |

Add to `.env`:

```bash
CHAT_SERVER_HOST=0.0.0.0
TRUSTED_PROXY_IPS=<proxy-ip>
TRUSTED_PROXY_HEADER=X-Forwarded-User   # change to match your provider
```

**Important:** The trusted IP must be the direct network peer (the proxy's actual IP as seen by NanoClaw), not an upstream address behind another proxy.

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

The webchat server needs a room registered as the **main NanoClaw group** so the primary bot instance (not a sub-agent) is connected. This gives it elevated privileges: no trigger word required, ability to manage other groups, and full IPC access.

### Check for existing main group

```bash
npx tsx -e "
import { initDatabase, getAllRegisteredGroups } from './src/db.ts';
initDatabase();
const groups = getAllRegisteredGroups();
const entries = Object.entries(groups);
const mainEntry = entries.find(([, g]) => g.isMain);
if (mainEntry) console.log('EXISTING_MAIN=' + mainEntry[1].folder + ' JID=' + mainEntry[0]);
else console.log('NO_MAIN');
"
```

If a main group already exists on another channel (e.g. `whatsapp_main`), ask the user whether they want to:
1. **Keep the existing main** and register the webchat room as a regular (sub-agent) group
2. **Move the main to webchat** (the old main becomes a regular group)

### Ask the user to choose a room name

Present these options for the main control room:

1. `control-room` — "Control Room" (recommended — clear purpose)
2. `bridge` — "Bridge" (Star Trek inspired)
3. `main` — "Main" (simple and direct)
4. Custom — let the user type their own

### Create the room and register

Once the user picks a name (e.g. `control-room`), create the chat room and register it as the main group:

```bash
# Read assistant name from .env
ASSISTANT_NAME=$(grep '^ASSISTANT_NAME=' .env | sed 's/ASSISTANT_NAME=//;s/"//g' || echo "Andy")
TRIGGER="@${ASSISTANT_NAME}"

npx tsx setup/index.ts --step register \
  --jid "chat:<room_id>" \
  --name "<room_name>" \
  --trigger "$TRIGGER" \
  --folder "chat_<room_id>" \
  --channel webchat \
  --assistant-name "$ASSISTANT_NAME" \
  --is-main \
  --no-trigger-required
```

Replace `<room_id>` and `<room_name>` with the user's choice (e.g. `control-room` / `Control Room`).

### Seed the room in chat-db

The room must also exist in the chat database so it appears in the PWA. Create it directly (the API may not be running yet):

```bash
npx tsx -e "
import { initChatDatabase, createChatRoom } from './src/chat-db.ts';
initChatDatabase('data');
createChatRoom('<room_id>', '<room_name>');
console.log('Chat room created');
"
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
| `/api/bots` | GET | List registered bots/groups |
| `/api/bots/:jid` | PUT | Update a bot |
| `/api/bots/:jid` | DELETE | Delete a bot |
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
