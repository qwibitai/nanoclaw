---
name: add-astrbot
description: Add AstrBot as a channel via an HTTP bridge and control endpoint.
---

# Add AstrBot Channel

This skill adds an AstrBot HTTP bridge to NanoClaw, then guides you through AstrBot plugin setup and verification.

## Phase 1: Pre-flight

Check if the AstrBot channel already exists:

```bash
test -f src/channels/astrbot-http.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Setup).

## Phase 2: Apply Code Changes

Merge the skill branch:

```bash
git fetch upstream skill/astrbot
git merge upstream/skill/astrbot
```

> Note: `upstream` is the remote pointing to `qwibitai/nanoclaw`. If you use a different name, substitute it.

This adds:
- `src/channels/astrbot-http.ts` (HTTP bridge and control endpoint)
- `import './astrbot-http.js'` in `src/channels/index.ts`
- Channel registry hooks for `registerGroup`, `setMainGroup`, `resetSession`
- Session cleanup helper in `src/index.ts`

### Validate

```bash
npm run build
```

## Phase 3: Setup

### Configure NanoClaw

Add to `.env`:

```bash
ASTRBOT_HTTP_HOST=127.0.0.1
ASTRBOT_HTTP_PORT=7801
ASTRBOT_HTTP_TOKEN=your_shared_secret
ASTRBOT_API_BASE=http://127.0.0.1:6185
ASTRBOT_API_KEY=abk_xxx
```

Notes:
- `ASTRBOT_HTTP_TOKEN` is optional but recommended. It must match the AstrBot plugin config.
- If AstrBot runs on another machine, set `ASTRBOT_HTTP_HOST=0.0.0.0` and protect it with a token and firewall.
- `ASTRBOT_API_BASE` and `ASTRBOT_API_KEY` are required for NanoClaw to send replies back to AstrBot. Inbound messages still work without them, but replies will be skipped.

Restart NanoClaw:

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

### Install AstrBot Plugin

Install the `nanoclaw_bridge` plugin in AstrBot, then enable it.

Example (git clone into AstrBot plugins directory):

```bash
cd /path/to/astrbot/plugins
git clone https://github.com/pjh456/astrbot_plugin_nanoclaw_bridge.git
```

If your AstrBot uses a different plugins path, adjust accordingly.

If AstrBot runs in Docker and you use the Web UI:
1. Open the AstrBot Web UI.
2. Go to `Astrbot Plugins` -> `Install from URL`.
3. Paste this URL and confirm:
   `https://github.com/pjh456/astrbot_plugin_nanoclaw_bridge`
4. Enable the plugin after installation completes.

Plugin settings:
- `nanoclaw_inbound_url`: `http://127.0.0.1:7801/astrbot/inbound`
- `nanoclaw_control_url`: `http://127.0.0.1:7801/astrbot/control` (optional; auto-derived if empty)
- `nanoclaw_token`: same as `ASTRBOT_HTTP_TOKEN`
- `forward_mode`: `all` | `command` | `mention`
- `command_prefix`: default `/nc `
- `block_astrbot_on_forward`: true (recommended)
- `ignore_self`: true (recommended)

### Create AstrBot API Key

The `ASTRBOT_API_KEY` is required for NanoClaw to send replies back to AstrBot.

In the AstrBot Web UI:
1. Open `Settings` -> `API Keys`.
2. Create a new API key and copy it.
3. Set it as `ASTRBOT_API_KEY` in NanoClaw `.env` and restart NanoClaw.

## Phase 4: Registration

AstrBot chats auto-register when messages arrive. Set your **main** control chat by sending:

```
/nc_main
```

This marks the current chat as main (no trigger required). Other chats remain trigger-based (default trigger pattern from NanoClaw config).

## Phase 5: Verify

1. Send a normal message from AstrBot.
2. NanoClaw should respond back through AstrBot.
3. Check status:

```
/nc_status
```

4. Optional: reset the session for the current chat:

```
/nc_reset
```

## Troubleshooting

1. No inbound messages:
   - Check NanoClaw logs for `AstrBot HTTP channel listening`
   - Verify `ASTRBOT_HTTP_HOST` and port match the plugin settings
   - If using a token, ensure `nanoclaw_token` matches `ASTRBOT_HTTP_TOKEN`
2. Inbound works, but no replies:
   - Set `ASTRBOT_API_BASE` and `ASTRBOT_API_KEY`
   - Ensure AstrBot API is reachable from the NanoClaw host
3. Main chat not set:
   - Send `/nc_main` from the desired chat
