---
name: add-tailscale
description: Add Tailscale VPN to the NanoClaw agent container. The agent can reach private tailnet hosts by hostname. Uses userspace networking (no root required).
---

# Add Tailscale Plugin

This skill adds Tailscale support to NanoClaw. The agent container connects to your tailnet on startup using userspace networking mode, giving it access to private hosts and services.

## Phase 1: Pre-flight

Check if `src/plugins/tailscale.ts` exists. If it does, skip to Phase 3 (Setup) — the code changes are already in place.

## Phase 2: Apply Code Changes

### Ensure plugin infrastructure exists

Check if `src/plugins/registry.ts` exists. If not, the plugin system hasn't been installed yet — this is unexpected since it ships with the core codebase. Stop and ask the user to check their installation.

### Write the plugin module

Check https://pkgs.tailscale.com/stable/ for the latest stable version. Copy `${CLAUDE_SKILL_DIR}/files/tailscale.ts` to `src/plugins/tailscale.ts`, replacing `1.82.0` in the archive URL with the actual latest stable version.

### Create the init script

Copy `${CLAUDE_SKILL_DIR}/files/tailscale.sh` to `container/plugins/tailscale.sh`.

This script is sourced by `container/entrypoint.sh` before the agent runs whenever `TAILSCALE_AUTH_KEY` is set in the container environment.

### Register in the plugins barrel

Append to `src/plugins/index.ts`:

```typescript
import './tailscale.js';
```

### Add env var documentation

Add to `.env.example`:

```
TAILSCALE_AUTH_KEY=tskey-auth-...
TAILSCALE_HOSTNAME=nanoclaw
```

### Create container skill

Copy `${CLAUDE_SKILL_DIR}/container/skills/tailscale/SKILL.md` to `container/skills/tailscale/SKILL.md`.

### Validate code changes

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Generate an auth key

1. Go to https://login.tailscale.com/admin/settings/keys
2. Click **Generate auth key**
3. Check **Reusable** so the container can reconnect across restarts
4. Optionally set an expiry (90 days recommended)
5. Copy the key (`tskey-auth-...`)

### Configure environment

Add to `.env`:

```
TAILSCALE_AUTH_KEY=tskey-auth-<your-key>
TAILSCALE_HOSTNAME=nanoclaw
```

### Rebuild the container image

The tailscale binaries need to be baked into the image. The build script auto-generates `plugins/binaries.json` from the plugin registry before building — do not edit that file manually.

```bash
container/build.sh
```

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

Ask the user to send a message to the agent:

> `tailscale status`

The agent should respond with the list of tailnet peers. If tailscale is not connected, check that `TAILSCALE_AUTH_KEY` is set in `.env` and the image was rebuilt.

## Troubleshooting

**`tailscale: command not found` inside the container**
The binary wasn't installed. Rebuild: `container/build.sh`

**Agent starts but tailscale not connected**
Check that `TAILSCALE_AUTH_KEY` is set in `.env` (not just `.env.example`). Check that `container/plugin-init/tailscale.sh` exists and the image was rebuilt.

**Auth key expired**
Generate a new reusable auth key at https://login.tailscale.com/admin/settings/keys, update `.env`, and restart.
