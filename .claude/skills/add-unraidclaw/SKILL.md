---
name: add-unraidclaw
description: Add UnraidClaw MCP server so the container agent can monitor and control an Unraid server — list Docker containers, check array status, view system metrics, manage containers, read syslog, and more.
---

# Add UnraidClaw Integration

This skill adds a stdio-based MCP server that exposes the UnraidClaw REST API as tools for the container agent.

Tools added:
- `unraidclaw_health` — API health check
- `unraidclaw_docker_list` / `_get` / `_logs` / `_action` — Docker container management (start/stop/restart/pause)
- `unraidclaw_array_status` — Unraid array state (started/stopped, disk states, parity info)
- `unraidclaw_system_info` / `_metrics` — Static info and live CPU/memory/temp metrics
- `unraidclaw_notifications_list` / `_create` — Unraid notifications
- `unraidclaw_logs_syslog` — Syslog access with optional tail/filter
- `unraidclaw_disks` — Disk health and SMART data
- `unraidclaw_shares` — User shares

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/unraidclaw-mcp-stdio.ts` already exists. If it does, skip to Phase 3 (Configure).

### Locate the source file

The MCP server source lives in the nanoclaw-unraidclaw repo, expected adjacent to this repo:

```bash
ls ../nanoclaw-unraidclaw/src/unraidclaw-mcp-stdio.ts
```

If the file is missing, tell the user:

> The nanoclaw-unraidclaw repo was not found at `../nanoclaw-unraidclaw`. Clone it adjacent to this repo:
>
> ```bash
> git clone https://github.com/qwibitai/nanoclaw-unraidclaw.git ../nanoclaw-unraidclaw
> ```

### Ask for configuration

Ask the user for:

1. **UNRAIDCLAW_URL** — base URL of the UnraidClaw API (e.g. `https://unraid-syd:9876`)
2. **UNRAIDCLAW_API_KEY** — API key configured in UnraidClaw

### Verify UnraidClaw is reachable

Test connectivity using the values the user provided (use `-k` for self-signed TLS):

```bash
curl -sk -H "X-API-Key: <UNRAIDCLAW_API_KEY>" <UNRAIDCLAW_URL>/api/health
```

If the response is not valid JSON or the command fails, stop and tell the user:

> Cannot reach UnraidClaw at `<UNRAIDCLAW_URL>`. Please verify:
> - UnraidClaw is running on the Unraid server
> - The URL and port are correct
> - The API key is valid

Do not proceed until the health check succeeds.

## Phase 2: Apply Code Changes

### Copy the MCP server

```bash
cp ../nanoclaw-unraidclaw/src/unraidclaw-mcp-stdio.ts container/agent-runner/src/
```

### Wire into agent-runner index.ts

Open `container/agent-runner/src/index.ts` and make three edits:

**1. Add the server path variable** — immediately after the `mcpServerPath` line (the one referencing `ipc-mcp-stdio.js`), add:

```typescript
const unraidclawMcpServerPath = path.join(__dirname, 'unraidclaw-mcp-stdio.js');
```

**2. Add to `allowedTools`** — in the `allowedTools` array, append:

```typescript
'mcp__unraidclaw__*'
```

**3. Add to `mcpServers`** — inside the `mcpServers` object, after the closing brace of the `nanoclaw` entry, add:

```typescript
unraidclaw: {
  command: 'node',
  args: [unraidclawMcpServerPath],
  env: {
    UNRAIDCLAW_URL: sdkEnv.UNRAIDCLAW_URL ?? '',
    UNRAIDCLAW_API_KEY: sdkEnv.UNRAIDCLAW_API_KEY ?? '',
  },
},
```

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Update them:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/unraidclaw-mcp-stdio.ts "$dir/"
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### Build

```bash
npm run build
./container/build.sh
```

Build must be clean before proceeding. If there are TypeScript errors, read and fix them before continuing.

## Phase 3: Configure

### Add env vars to .env

Append to `.env`:

```bash
UNRAIDCLAW_URL=<value provided by user>
UNRAIDCLAW_API_KEY=<value provided by user>
```

Also add placeholder entries to `.env.example` if not already present:

```bash
UNRAIDCLAW_URL=
UNRAIDCLAW_API_KEY=
```

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test with a health check

Tell the user:

> Send a message like: "use unraidclaw_health to check if the Unraid server is up"
>
> The agent should call `unraidclaw_health` and return the status JSON from your Unraid server.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i unraidclaw
```

Look for tool calls like `mcp__unraidclaw__health` appearing in agent output.

## Troubleshooting

### "Failed to connect" or TLS errors

UnraidClaw uses a self-signed certificate. The MCP server sets `NODE_TLS_REJECT_UNAUTHORIZED=0` at startup, so this should be handled automatically. If errors persist:

1. Verify the URL is reachable from the host: `curl -sk <UNRAIDCLAW_URL>/api/health`
2. Ensure `UNRAIDCLAW_URL` in `.env` has no trailing slash

### Agent doesn't use UnraidClaw tools

1. Check `container/agent-runner/src/index.ts` has `'mcp__unraidclaw__*'` in `allowedTools`
2. Check the `unraidclaw` entry is in `mcpServers`
3. Verify the per-group source was updated (see Phase 2)
4. Confirm the container image was rebuilt with `./container/build.sh`
5. Try being explicit: "use the unraidclaw_docker_list tool to show my running containers"

### Tool calls fail with 401 / auth errors

Check that `UNRAIDCLAW_API_KEY` in `.env` matches the key configured in UnraidClaw settings.

### Agent runner won't start after changes

Check for build errors:

```bash
cd container/agent-runner && npx tsc --noEmit
```

Common cause: forgot to declare `unraidclawMcpServerPath` before using it in `mcpServers`.
