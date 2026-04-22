---
name: add-unraidclaw
description: Add UnraidClaw MCP server so the container agent can monitor and control an Unraid server — list Docker containers, check array status, view system metrics, manage containers, read syslog, and more.
---

# Add UnraidClaw Integration

This skill adds a stdio-based MCP server that exposes the UnraidClaw REST API as tools for the container agent.

Supports one or more Unraid servers. Each server gets 13 dedicated tools prefixed with its sanitized name (hyphens replaced with underscores), plus two aggregate tools.

**Per-server tools** (replace `<name>` with the sanitized server name, e.g. `unraid_syd`):
- `unraidclaw_<name>__health` — API health check
- `unraidclaw_<name>__docker_list` / `__docker_get` / `__docker_logs` / `__docker_action` — Docker container management
- `unraidclaw_<name>__array_status` — Array state (started/stopped, disk states, parity info)
- `unraidclaw_<name>__system_info` / `__system_metrics` — Static info and live CPU/memory/temp metrics
- `unraidclaw_<name>__notifications_list` / `__notification_create` — Unraid notifications
- `unraidclaw_<name>__logs_syslog` — Syslog access with optional tail/filter
- `unraidclaw_<name>__disks` — Disk health and SMART data
- `unraidclaw_<name>__shares` — User shares

**Aggregate tools** (always registered regardless of server count):
- `unraidclaw_list_servers` — List all configured servers (name and URL)
- `unraidclaw_all_docker_list` — List Docker containers across all servers, labelled by server name

All tool calls from the agent use the MCP prefix: `mcp__unraidclaw__unraidclaw_<name>__<tool>`

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

Ask the user: **"Do you have one Unraid server or multiple?"**

**Single server** — ask for:
1. **UNRAIDCLAW_URL** — base URL of the UnraidClaw API (e.g. `https://unraid-syd:9876`)
2. **UNRAIDCLAW_API_KEY** — API key configured in UnraidClaw

This will use `UNRAIDCLAW_URL` + `UNRAIDCLAW_API_KEY`. The server is treated as named `default`, so tools are named `unraidclaw_default__health`, etc. To get a friendlier name, use the multi-server format instead.

**Multiple servers** (or single with a custom name) — ask for each server:
1. **Name** — short identifier, e.g. `unraid-syd` (hyphens are replaced with underscores in tool names)
2. **URL** — base URL of its UnraidClaw API
3. **API key** — API key configured in UnraidClaw

This will use `UNRAIDCLAW_SERVERS` as a JSON array (see Phase 3).

### Verify UnraidClaw is reachable

Test connectivity for each server (use `-k` for self-signed TLS):

```bash
curl -sk -H "X-API-Key: <API_KEY>" <URL>/api/health
```

If the response is not valid JSON or the command fails, stop and tell the user:

> Cannot reach UnraidClaw at `<URL>`. Please verify:
> - UnraidClaw is running on the Unraid server
> - The URL and port are correct
> - The API key is valid

Do not proceed until health checks succeed for all servers.

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
    UNRAIDCLAW_SERVERS: sdkEnv.UNRAIDCLAW_SERVERS ?? '',
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

**Single server** — append to `.env`:

```bash
UNRAIDCLAW_URL=<url provided by user>
UNRAIDCLAW_API_KEY=<key provided by user>
```

**Multiple servers (or single with a custom name)** — append to `.env`:

```bash
UNRAIDCLAW_SERVERS=[{"name":"unraid-syd","url":"https://unraid-syd:9876","apiKey":"..."},{"name":"unraid-mel","url":"https://unraid-mel:9876","apiKey":"..."}]
```

Each entry requires `name`, `url`, and `apiKey`. Hyphens in `name` are replaced with underscores in tool names (e.g. `unraid-syd` → `unraidclaw_unraid_syd__health`).

Also add placeholder entries to `.env.example` if not already present:

```bash
UNRAIDCLAW_SERVERS=
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

> Send a message like: "use unraidclaw_list_servers to show all configured Unraid servers"
>
> The agent should call `mcp__unraidclaw__unraidclaw_list_servers` and return the list of servers.
>
> Per-server tools follow the pattern `mcp__unraidclaw__unraidclaw_<name>__<tool>` where `<name>` is the sanitized server name (hyphens → underscores). For example, a server named `unraid-syd` exposes:
> - `mcp__unraidclaw__unraidclaw_unraid_syd__health`
> - `mcp__unraidclaw__unraidclaw_unraid_syd__docker_list`
> - `mcp__unraidclaw__unraidclaw_unraid_syd__array_status`
>
> For a single server configured via `UNRAIDCLAW_URL` (no `UNRAIDCLAW_SERVERS`), the name is `default`:
> - `mcp__unraidclaw__unraidclaw_default__health`

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i unraidclaw
```

Look for tool calls like `mcp__unraidclaw__unraidclaw_health` appearing in agent output.

## Troubleshooting

### "Failed to connect" or TLS errors

UnraidClaw uses a self-signed certificate. The MCP server sets `NODE_TLS_REJECT_UNAUTHORIZED=0` at startup, so this should be handled automatically. If errors persist:

1. Verify the URL is reachable from the host: `curl -sk <URL>/api/health`
2. Ensure the URL in `.env` has no trailing slash

### Agent doesn't use UnraidClaw tools

1. Check `container/agent-runner/src/index.ts` has `'mcp__unraidclaw__*'` in `allowedTools`
2. Check the `unraidclaw` entry is in `mcpServers` and passes `UNRAIDCLAW_SERVERS`, `UNRAIDCLAW_URL`, and `UNRAIDCLAW_API_KEY`
3. Verify the per-group source was updated (see Phase 2)
4. Confirm the container image was rebuilt with `./container/build.sh`
5. Try being explicit: "use unraidclaw_list_servers to show all configured Unraid servers"

### Tool calls fail with 401 / auth errors

Check that the API key in `.env` matches the key configured in UnraidClaw settings. For multi-server, check each `apiKey` in the `UNRAIDCLAW_SERVERS` JSON array.

### Agent runner won't start after changes

Check for build errors:

```bash
cd container/agent-runner && npx tsc --noEmit
```

Common cause: forgot to declare `unraidclawMcpServerPath` before using it in `mcpServers`.
