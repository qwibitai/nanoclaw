---
name: add-homeassistant
description: Add Home Assistant integration to NanoClaw. Lets the container agent query entity states, call services, list automations, and retrieve state history via the Home Assistant REST API. Requires a Long-Lived Access Token.
---

# Add Home Assistant Integration

This skill adds a stdio-based MCP server that exposes the Home Assistant REST API as tools for the container agent.

Tools added:
- `ha_get_states` — list all entity states, optionally filtered by domain (light, switch, climate, sensor, etc.)
- `ha_get_state` — get the current state of a specific entity by entity_id
- `ha_call_service` — call any HA service (turn on lights, set thermostat, trigger scripts, etc.)
- `ha_list_automations` — list all automations with friendly name, state (on/off), and last triggered time
- `ha_get_history` — get state history for an entity over the last N hours

All tool calls from the agent use the MCP prefix: `mcp__homeassistant__ha_<tool>`

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/homeassistant-mcp-stdio.ts` already exists. If it does, skip to Phase 3 (Configure).

### Collect credentials

Use `AskUserQuestion` to collect the Home Assistant URL and token:

> What is your Home Assistant URL?
>
> - If NanoClaw and Home Assistant are on the **same Docker network**, use the container name: `http://homeassistant:8123`
> - If Home Assistant runs in **host network mode** or on a different host, use the host IP or hostname: `http://192.168.1.x:8123`
>
> Default: `http://homeassistant:8123`

Then:

> Please provide a Long-Lived Access Token for Home Assistant.
>
> To create one:
> 1. Open Home Assistant in your browser
> 2. Click your profile icon (bottom-left)
> 3. Scroll to **Long-Lived Access Tokens**
> 4. Click **Create Token**, give it a name (e.g. "NanoClaw"), and copy the token

### Test API connectivity

```bash
curl -s -H "Authorization: Bearer <HA_TOKEN>" \
  "<HA_URL>/api/" | head -c 200
```

The response should be JSON with a `message` field like `"API running."`. If the request fails (401/403/connection refused), stop and tell the user to check the URL and token before proceeding.

## Phase 2: Apply Code Changes

### Write the MCP server

Create `container/agent-runner/src/homeassistant-mcp-stdio.ts` with exactly the following content (taken from the skill's base directory at `container/agent-runner/src/homeassistant-mcp-stdio.ts` if it already exists there, otherwise write it fresh).

The file is already present in this repo at `container/agent-runner/src/homeassistant-mcp-stdio.ts` — verify it exists and is non-empty before proceeding.

### Wire into agent-runner index.ts

Open `container/agent-runner/src/index.ts` and make five edits:

**1. Add path variable** — immediately after the `tailscaleMcpServerPath` line, add:

```typescript
const homeassistantMcpServerPath = path.join(__dirname, 'homeassistant-mcp-stdio.js');
```

**2. Add to `runQuery` function signature** — in the `runQuery` function parameters, after `tailscaleMcpServerPath: string`, add:

```typescript
homeassistantMcpServerPath: string,
```

**3. Add to `allowedTools`** — in the `allowedTools` array, after `'mcp__tailscale__*'`, add:

```typescript
'mcp__homeassistant__*',
```

**4. Add to `mcpServers`** — inside the `mcpServers` object, after the closing brace of the `tailscale` entry, add:

```typescript
homeassistant: {
  command: 'node',
  args: [homeassistantMcpServerPath],
  env: {
    HA_URL: sdkEnv.HA_URL ?? '',
    HA_TOKEN: sdkEnv.HA_TOKEN ?? '',
  },
},
```

**5. Update the `runQuery` call site** — find the call to `runQuery(...)` in `main()` and add `homeassistantMcpServerPath` after `tailscaleMcpServerPath`:

```typescript
// Before:
const queryResult = await runQuery(prompt, sessionId, mcpServerPath, unraidclawMcpServerPath, tailscaleMcpServerPath, containerInput, sdkEnv, resumeAt);
// After:
const queryResult = await runQuery(prompt, sessionId, mcpServerPath, unraidclawMcpServerPath, tailscaleMcpServerPath, homeassistantMcpServerPath, containerInput, sdkEnv, resumeAt);
```

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Update them:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/homeassistant-mcp-stdio.ts "$dir/"
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### Build

```bash
npm run build
./container/build.sh
```

Build must be clean before proceeding. If there are TypeScript errors, read and fix them before continuing.

## Phase 2b: Update container-runner.ts

### Update container-runner.ts

The main NanoClaw process passes environment variables to agent containers explicitly. Open `src/container-runner.ts` and add the following two blocks immediately after the `TAILSCALE_TAILNET` block:

```typescript
  if (process.env.HA_URL) {
    args.push('-e', `HA_URL=${process.env.HA_URL}`);
  }
  if (process.env.HA_TOKEN) {
    args.push('-e', `HA_TOKEN=${process.env.HA_TOKEN}`);
  }
```

Without this step the Home Assistant MCP server will start but will have no credentials and all tool calls will fail.

## Phase 3: Configure

### Configure environment variables

On Unraid/Docker deployments: add the variables directly to the NanoClaw container template via the Unraid Docker UI (edit container → add variables). The credential proxy passes them to child containers automatically.

Variables to add:

```
HA_URL=http://homeassistant:8123
HA_TOKEN=<long-lived-access-token>
```

**URL note:** Use the container name (`homeassistant`) if HA is on the same Docker bridge network as NanoClaw. Use the host IP (e.g. `http://192.168.1.x:8123`) if HA runs in host network mode or on a separate machine.

On standard Linux/macOS deployments: append to `.env` and sync:

```bash
HA_URL=http://homeassistant:8123
HA_TOKEN=<long-lived-access-token>
```

Then sync:
```bash
cp .env data/env/env
```

Also add placeholder entries to `.env.example` if not already present:

```bash
HA_URL=
HA_TOKEN=
```

### Restart the service

On Unraid/Docker deployments, restart via SSH:
```bash
docker restart NanoClaw
```
On standard Linux: `systemctl --user restart nanoclaw`
On macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

## Phase 4: Verify

### Test the tools

Tell the user:

> Send a message like: "what lights are on in Home Assistant?"
>
> The agent should call `mcp__homeassistant__ha_get_states` (with domain filter `light`) and return the light entity states.
>
> To test service calls: "turn off all the lights"
> The agent will call `mcp__homeassistant__ha_call_service` with the `light.turn_off` service.
>
> To test history: "has the front door been open today?"
> The agent will call `mcp__homeassistant__ha_get_history` for the relevant sensor.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i homeassistant
```

Look for tool calls like `mcp__homeassistant__ha_get_states` appearing in agent output.

## Troubleshooting

### "HA_URL and HA_TOKEN must be set"

The env vars are not reaching the container agent. Check:
1. The vars are set in the NanoClaw container environment (Unraid Docker UI) or in `.env` AND synced to `data/env/env`
2. The `homeassistant` entry in `mcpServers` passes both env vars
3. The service was restarted after adding the variables

### 401 Unauthorized

The token is invalid or expired. To create a new one:
1. Open Home Assistant → Profile (bottom-left) → **Long-Lived Access Tokens**
2. Delete the old token if present, create a new one
3. Update `HA_TOKEN` in the NanoClaw container environment and restart

### Connection refused / timeout

The `HA_URL` is wrong or unreachable from inside the agent container. Check:
1. If HA and NanoClaw are on the same Docker network, use the container name: `http://homeassistant:8123`
2. If HA is in host network mode, use the host's IP from inside the container: `http://172.17.0.1:8123` (default Docker bridge gateway) or the LAN IP
3. Test reachability: `docker exec NanoClaw curl -s http://homeassistant:8123/api/` (adjust container name as needed)

### Agent doesn't use Home Assistant tools

1. Check `container/agent-runner/src/index.ts` has `'mcp__homeassistant__*'` in `allowedTools`
2. Check the `homeassistant` entry is in `mcpServers` with both env vars
3. Verify the per-group source was updated (see Phase 2)
4. Confirm the container image was rebuilt with `./container/build.sh`
5. Try being explicit: "use the ha_get_states tool to list all lights"

### Home Assistant tools return "credentials not set" but env vars are configured

`HA_URL` and `HA_TOKEN` are set in the NanoClaw container but not being forwarded to agent containers. Verify `src/container-runner.ts` has the two HA passthrough blocks from Phase 2b. If missing, add them and rebuild: `npm run build` then rebuild and push the main NanoClaw image.

### Agent runner won't start after changes

Check for TypeScript errors:

```bash
cd container/agent-runner && npx tsc --noEmit
```

Common cause: `homeassistantMcpServerPath` parameter added to signature but not to the call site (or vice versa).

### ha_get_history returns empty results

Home Assistant's history recorder may not be tracking the entity. Check:
1. The entity_id is correct (use `ha_get_states` to confirm)
2. The `recorder` integration is enabled in HA (it is by default)
3. The requested hours value isn't too large — HA's default history retention is 10 days

## Removal

To remove the Home Assistant integration:

1. Delete `container/agent-runner/src/homeassistant-mcp-stdio.ts`
2. Remove the `homeassistantMcpServerPath` variable, `homeassistantMcpServerPath` parameter, `'mcp__homeassistant__*'` from `allowedTools`, and the `homeassistant` entry from `mcpServers` in `container/agent-runner/src/index.ts`
3. Remove `HA_URL` and `HA_TOKEN` from `.env` and sync: `cp .env data/env/env`
4. Remove placeholder lines from `.env.example`
5. Rebuild: `npm run build && ./container/build.sh`
6. Restart:
```bash
docker restart NanoClaw  # Unraid/Docker
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux: systemctl --user restart nanoclaw
```
