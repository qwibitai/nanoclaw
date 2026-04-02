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

Check https://pkgs.tailscale.com/stable/ for the latest stable version, then create `src/plugins/tailscale.ts`:

```typescript
import { registerPlugin } from './registry.js';

registerPlugin({
  name: 'tailscale',
  containerEnvKeys: ['TAILSCALE_AUTH_KEY', 'TAILSCALE_HOSTNAME'],
  initScript: 'plugin-init/tailscale.sh',
  binaryInstall: {
    archive: 'https://pkgs.tailscale.com/stable/tailscale_1.82.0_amd64.tgz',
    extract: ['tailscale', 'tailscaled'],
    dest: '/usr/local/bin/',
  },
});
```

Replace `1.82.0` with the actual latest stable version.

### Create the init script

Create `container/plugins/tailscale.sh`:

```bash
#!/bin/bash
# Start Tailscale in userspace networking mode (no root or /dev/net/tun needed)
if [ -n "$TAILSCALE_AUTH_KEY" ]; then
    tailscaled --state=mem: --tun=userspace-networking --socket=/tmp/tailscale.sock 2>/tmp/tailscaled.log &
    # Wait for daemon socket to appear (up to 10 s)
    for i in $(seq 1 10); do
        tailscale --socket=/tmp/tailscale.sock status >/dev/null 2>&1 && break
        sleep 1
    done
    TS_UP_ARGS="--auth-key=$TAILSCALE_AUTH_KEY --accept-routes --timeout=10s"
    if [ -n "$TAILSCALE_HOSTNAME" ]; then
        TS_UP_ARGS="$TS_UP_ARGS --hostname=$TAILSCALE_HOSTNAME"
    fi
    mkdir -p /var/run/tailscale
    ln -sf /tmp/tailscale.sock /var/run/tailscale/tailscaled.sock
    tailscale --socket=/tmp/tailscale.sock up $TS_UP_ARGS || true
    # Serve port 8088 over HTTPS on the tailnet
    tailscale --socket=/tmp/tailscale.sock serve --bg 8088 2>/tmp/tailscale-serve.log || true
    echo "[tailscale] Setup complete"
fi
```

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

Create `container/skills/tailscale/SKILL.md`:

```markdown
---
name: tailscale
description: Tailscale VPN — the container is connected to a tailnet. Use tailscale hostnames to reach private services.
---

# Tailscale VPN

This container is connected to a Tailscale network (tailnet). You can reach private hosts by their Tailscale hostname or IP.

## What you can do

- Access internal APIs, databases, or services by tailscale hostname (e.g. `http://my-server:8080`)
- Use `tailscale status` to see connected peers
- Use `tailscale ping <hostname>` to check reachability

## Notes

- Tailscale runs in userspace networking mode
- DNS for tailnet hostnames resolves automatically via `100.100.100.100`
- Internet traffic routes normally (not through tailnet unless `--exit-node` was configured)
```

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
