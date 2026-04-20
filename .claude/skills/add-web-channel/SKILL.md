---
name: add-web-channel
description: Add a browser-based web channel. Serves a mobile-friendly chat UI directly from NanoClaw — no Redis, no separate app. The index page lists all registered conversations; each opens as a full-screen portal sharing history and memory with its source channel (WhatsApp, Telegram, etc).
---

# Add Web Channel

This skill adds a browser-based chat interface to NanoClaw. The web UI is served directly by NanoClaw on a configurable port, requires no external services, and is installable as a PWA on iOS and Android.

**Design:** The web channel is a multi-conversation portal. The index page at `/` lists every registered group. Tapping a conversation opens `/c/<folder>` — a full-screen chat that shares the same CLAUDE.md, mnemon memory, and message history as the source channel. Open it on any device via Tailscale (or your LAN) and you see the same assistant, the same context, the full history from all channels.

## Phase 1: Pre-flight

Check if the channel is already installed:

```bash
test -f src/channels/web.ts && echo "already installed"
```

If already installed, skip to Phase 3 (Configure).

## Phase 2: Merge the skill branch

```bash
git fetch upstream
git merge upstream/skill/add-web-channel --no-edit
npm install
npm run build
```

Resolve any conflicts (unlikely — web.ts is a new file). If `src/channels/index.ts` conflicts, keep both the existing channel imports AND the new `import './web.js'` line.

## Phase 3: Configure

Add to `.env`:

```
WEB_CHANNEL_PORT=3080
WEB_CHANNEL_TOKEN=
```

**Port:** Choose any open port. 3080 is the default. If you're exposing via Tailscale, pick something you'll remember.

**Token:** Generate a random token for authentication:

```bash
openssl rand -hex 16
```

Paste the output as `WEB_CHANNEL_TOKEN`. If left empty, the web UI is accessible to anyone who can reach the port — fine for Tailscale-only setups, not recommended for public exposure.

## Phase 4: Restart

```bash
# Linux (systemd)
systemctl --user restart nanoclaw

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 5: Verify

Check logs for the startup message:

```bash
tail -20 logs/nanoclaw.log | grep "Web channel"
# Expected: Web channel listening  {"port": 3080}
```

Open in browser: `http://<your-pi-ip>:3080`

If you set a token, add it once as a query parameter — the server sets a session cookie so you don't need it again:

```
http://<host>:3080/?token=<your-token>
```

You should see the conversation index. Tap any group to open its chat.

Bookmark individual conversation URLs for quick access. On iPhone/iPad: tap Share → Add to Home Screen for a full-screen PWA.

## URL structure

```
GET /                      — conversation index (list of registered groups)
GET /c/<folder>            — chat UI for a specific group
GET /c/<folder>/history    — message history API (?since=<ISO timestamp>)
POST /c/<folder>/send      — send a message into the agent pipeline
GET /manifest.json         — PWA manifest
```

Messages sent from the web UI are routed through the group's real channel JID (e.g. the WhatsApp main JID), so the agent responds in its native context. Bot responses appear in both the web UI and the source channel.

## Trigger behaviour for non-main groups

Non-main groups with `requires_trigger = true` (the default) still require the trigger word (e.g. `@vbotpi`) in web messages. Main groups and groups with `requires_trigger = false` respond to all messages without a trigger.

## Troubleshooting

**Port already in use:** Change `WEB_CHANNEL_PORT` in `.env` and restart.

**401 Unauthorized:** Pass `?token=<token>` once in the URL — the cookie is then set for the session.

**Conversation not found (404):** The folder name in the URL must match a registered group's `folder` field in the DB. Check with:

```bash
sqlite3 store/messages.db "SELECT folder, name FROM registered_groups;"
```

**Messages from other channels not showing:** The history query pulls all messages for JIDs matching the group's folder. Confirm the group is registered with the correct folder name.
