---
name: add-home-assistant
description: Add Home Assistant integration to NanoClaw. Lets the agent control lights, sensors, and automations via the HA REST API using curl. No new dependencies required.
---

# Add Home Assistant Integration

This skill configures NanoClaw to control Home Assistant via its REST API. The agent uses `curl` (already in the container) — no Dockerfile changes needed.

## Phase 1: Collect Credentials

Ask the user for:

1. **HA URL** — the base URL of their Home Assistant instance, e.g. `http://homeassistant.local:8123` or `http://192.168.1.100:8123`
2. **Long-Lived Access Token** — created in HA at: **Profile → Security → Long-Lived Access Tokens → Create Token**

Wait for both values before proceeding.

## Phase 2: Apply Code Change

The `src/container-runner.ts` file needs 2 lines added to pass HA credentials into agent containers. Check if already applied:

```bash
grep -q "HA_URL" src/container-runner.ts && echo "already applied" || echo "needs change"
```

If not yet applied, find the block that pushes the `TZ` env var:

```typescript
  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);
```

And add immediately after it:

```typescript
  // Pass Home Assistant credentials if configured
  if (process.env.HA_URL) args.push('-e', `HA_URL=${process.env.HA_URL}`);
  if (process.env.HA_TOKEN) args.push('-e', `HA_TOKEN=${process.env.HA_TOKEN}`);
```

## Phase 3: Configure Environment

Write the credentials to `.env`:

```bash
HA_URL=<url-from-user>
HA_TOKEN=<token-from-user>
```

Then sync to the container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads from `data/env/env`, not `.env` directly.

## Phase 4: Build and Restart

```bash
npm run build
```

Then restart the service:

```bash
# Linux (systemd)
systemctl --user restart nanoclaw

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 5: Verify

Tell the user:

> Send a message to your NanoClaw channel:
>
> **"list my home assistant entities"**
>
> The agent should respond with a list of your HA devices. If HA_URL or HA_TOKEN are wrong, it will report a curl error.

If the agent responds with entity names and states, setup is complete.

## Troubleshooting

### "HA_URL is not set" or empty response

1. Confirm `.env` has both `HA_URL` and `HA_TOKEN`
2. Re-run: `cp .env data/env/env`
3. Restart the service

### curl: Could not resolve host

- Check the HA URL is reachable from the host machine: `curl -s http://homeassistant.local:8123/api/`
- Use IP address instead of hostname if DNS doesn't resolve inside the container

### 401 Unauthorized

- The token has expired or was deleted in HA
- Create a new Long-Lived Access Token and update `.env`

### Connection refused

- Home Assistant may be on a different port or not running
- Try `http://homeassistant.local:8123` and confirm HA is accessible from the host
