---
name: add-web-channel
description: Add a browser-based web channel. Serves a mobile-friendly chat UI directly from NanoClaw — no Redis, no separate app. Acts as a portal into your existing main group conversation, sharing its CLAUDE.md and memory. Works as a fallback when other channels (e.g. WhatsApp) are unavailable.
---

# Add Web Channel

This skill adds a browser-based chat interface to NanoClaw. The web UI is served directly by NanoClaw on a configurable port, requires no external services, and is installable as a PWA on iOS and Android.

**Design:** The web channel is a portal — it shares the same CLAUDE.md, mnemon memory, and conversation history as your main group. Open it on any device via Tailscale (or your LAN) and you see the same assistant, the same context, the full history from all channels.

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

Open in browser: `http://<your-pi-ip>:3080` (or `http://<tailscale-hostname>:3080`)

If you set a token: `http://<host>:3080/?token=<your-token>`

Bookmark that URL. On iPhone/iPad: tap Share → Add to Home Screen for a full-screen PWA.

## How it works

- `GET /` — chat UI (vanilla HTML/JS, no build step, no CDN dependencies)
- `GET /history` — loads recent messages from `messages.db`, including messages from all channels (WhatsApp, Telegram, etc.) that share the same group folder
- `GET /events` — Server-Sent Events stream; pushes new messages in real time
- `POST /send` — sends a message into the agent pipeline
- `GET /manifest.json` — PWA manifest for home screen installation

The web channel symlinks `groups/web/` to the main group's folder, so it shares CLAUDE.md, mnemon memory, and agent behaviour. It has its own session context (conversation history in the active agent window) but full access to long-term mnemon memory.

## Troubleshooting

**Port already in use:** Change `WEB_CHANNEL_PORT` in `.env` and restart.

**401 Unauthorized:** Your token in the URL doesn't match `WEB_CHANNEL_TOKEN`. Re-check `.env` and the bookmarked URL.

**Messages not appearing in real time:** The SSE connection may have dropped. Reload the page — history loads on every open, so you won't miss anything.

**WhatsApp messages not showing in web UI:** The history query pulls messages for all JIDs that share the main group's folder. Confirm the main group is registered in the DB with `is_main = 1`.
