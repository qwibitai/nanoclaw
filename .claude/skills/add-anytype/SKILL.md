# Add Anytype MCP Server

This skill connects NanoClaw to your Anytype knowledge base via the official
`@anyproto/anytype-mcp` MCP server. After installation, every NanoClaw agent
can search, read, create, and manage Anytype objects and spaces through natural
language — no additional TypeScript code required.

---

## Overview

- **Type:** MCP configuration skill (no new channel, no new TypeScript)
- **MCP server:** `@anyproto/anytype-mcp` (official, by anyproto)
- **Anytype runtime:** anytype-cli running in Docker Compose (`~/anytype/`), ports bridged to host
- **What agents gain:** global search, space/object CRUD, list management,
  properties, tags, types, templates — everything in the Anytype API

---

## Phase 1 — Check prerequisites

Anytype runs in Docker Compose. Verify the containers are up:

```bash
cd ~/anytype && docker compose ps
```

The anytype-cli service should show status `running`. The following ports must
be bridged to the host (verify with `docker compose port`):

| Port | Purpose |
|------|---------|
| `31012` | Anytype HTTP API |
| `47800` | Anytype media gateway |

If the containers are stopped:
```bash
cd ~/anytype && docker compose up -d
```

Verify Node.js ≥ 18 is available (required by the MCP server):
```bash
node --version
```

---

## Phase 2 — Store the API key via onecli

The API key must not be written to `.mcp.json` or `.env` in plaintext — store
it in onecli so it is injected at runtime, consistent with how NanoClaw handles
all other credentials.

```bash
onecli secret set ANYTYPE_API_KEY
# paste the key when prompted — it will not echo
```

Verify it was stored:
```bash
onecli secret list | grep ANYTYPE
```

---

## Phase 3 — Determine the correct API base URL

Anytype runs in Docker Compose with ports bridged to the host. NanoClaw agents
also run in Docker containers. `localhost` inside a NanoClaw container resolves
to the container itself — not the host and not the Anytype container.

Both Docker networks share the host via the bridge gateway `172.18.0.1`.

Add to `.env` (these are non-secret configuration values, not credentials):
```bash
ANYTYPE_API_BASE_URL=http://172.18.0.1:31012
ANYTYPE_HOST_IP=172.18.0.1   # used for media URL rewriting
```

If the gateway IP is ever uncertain, confirm it with:
```bash
docker network inspect bridge | grep Gateway
```

---

## Phase 4 — Handle media URL rewriting

Anytype serves media files (images, files, icons) from a local gateway on port
`47800`. When the MCP server returns objects containing media, the URLs look
like:

```
http://localhost:47800/image/...
http://127.0.0.1:47800/file/...
```

Inside a NanoClaw container these addresses are unreachable — `localhost`
resolves to the NanoClaw container itself, not the host, and not the Anytype
container. Both containers communicate via the host bridge at `172.18.0.1`,
so the URLs must be rewritten before responses reach the agent.

Create `src/anytype-media-proxy.ts`:

```typescript
/**
 * Rewrites Anytype media URLs so they are reachable from inside Docker.
 *
 * Anytype's media gateway runs on the host at port 47800.
 * Inside a container, localhost:47800 is unreachable — replace it with the
 * Docker bridge IP so agents can fetch images and files.
 */

const ANYTYPE_MEDIA_PORT = 47800;
const HOST_IP = process.env.ANYTYPE_HOST_IP ?? '172.18.0.1';
const LOCAL_PATTERNS = [
  /http:\/\/localhost:47800/g,
  /http:\/\/127\.0\.0\.1:47800/g,
];

export function rewriteAnytypeMediaUrls(text: string): string {
  let result = text;
  for (const pattern of LOCAL_PATTERNS) {
    result = result.replace(pattern, `http://${HOST_IP}:${ANYTYPE_MEDIA_PORT}`);
  }
  return result;
}

/**
 * Recursively rewrites all string values in a JSON-serialisable object.
 * Use this on raw MCP tool responses before passing them to agents.
 */
export function rewriteAnytypeMediaUrlsInObject(obj: unknown): unknown {
  if (typeof obj === 'string') return rewriteAnytypeMediaUrls(obj);
  if (Array.isArray(obj)) return obj.map(rewriteAnytypeMediaUrlsInObject);
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [
        k,
        rewriteAnytypeMediaUrlsInObject(v),
      ]),
    );
  }
  return obj;
}
```

Then import and apply `rewriteAnytypeMediaUrlsInObject` wherever MCP responses
from the `anytype` server are processed — typically in the agent runner or the
IPC handler that assembles the agent's context.

---

## Phase 5 — Create the MCP wrapper script

The wrapper script is the bridge between onecli and the MCP server. onecli
injects `ANYTYPE_API_KEY` as an environment variable at runtime; the wrapper
builds the `OPENAPI_MCP_HEADERS` JSON string from it and starts the server.
This way the key never appears in `.mcp.json` or any config file.

Create `scripts/anytype-mcp.sh`:

```bash
#!/usr/bin/env bash
# Wrapper for @anyproto/anytype-mcp
# ANYTYPE_API_KEY is injected by onecli at runtime — never hardcoded here.

set -euo pipefail

: "${ANYTYPE_API_KEY:?ANYTYPE_API_KEY is not set — run: onecli secret set ANYTYPE_API_KEY}"
: "${ANYTYPE_API_BASE_URL:?ANYTYPE_API_BASE_URL is not set in .env}"

export OPENAPI_MCP_HEADERS="{\"Authorization\":\"Bearer ${ANYTYPE_API_KEY}\", \"Anytype-Version\":\"2025-11-08\"}"

exec npx -y @anyproto/anytype-mcp
```

Make it executable:
```bash
chmod +x scripts/anytype-mcp.sh
```

---

## Phase 6 — Register the MCP server in `.mcp.json`

Read the current `.mcp.json` (or create it if absent). Add the `anytype` entry.
The key is **not** referenced here — it arrives via onecli at runtime.

```json
{
  "mcpServers": {
    "anytype": {
      "command": "bash",
      "args": ["scripts/anytype-mcp.sh"],
      "env": {
        "ANYTYPE_API_BASE_URL": "http://172.18.0.1:31012"
      }
    }
  }
}
```

Use this helper to merge it without overwriting other entries:

```bash
node -e "
const fs = require('fs');
const url = process.env.ANYTYPE_API_BASE_URL;
if (!url) { console.error('Missing ANYTYPE_API_BASE_URL in .env'); process.exit(1); }

let mcp = {};
try { mcp = JSON.parse(fs.readFileSync('.mcp.json', 'utf8')); } catch {}
mcp.mcpServers = mcp.mcpServers ?? {};
mcp.mcpServers.anytype = {
  command: 'bash',
  args: ['scripts/anytype-mcp.sh'],
  env: { ANYTYPE_API_BASE_URL: url }
};
fs.writeFileSync('.mcp.json', JSON.stringify(mcp, null, 2));
console.log('✓ .mcp.json updated');
"
```

Note: `ANYTYPE_API_KEY` is intentionally absent from `.mcp.json` — onecli
injects it into the wrapper's environment at container startup.

---

## Phase 7 — Verify connectivity

Test that the API is reachable from the host:

```bash
curl -s \
  -H "Authorization: Bearer $ANYTYPE_API_KEY" \
  -H "Anytype-Version: 2025-11-08" \
  "$ANYTYPE_API_BASE_URL/v1/spaces" | head -c 200
```

Should return `{"object":"space_list",...}`.

Test that the media gateway is reachable (use any image URL returned by the
API — the hash is just an example):
```bash
curl -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer $ANYTYPE_API_KEY" \
  "http://$ANYTYPE_HOST_IP:47800/image/<some-hash>"
# expect: 200
```

If you see `Connection refused` on port 47800:
- Check containers are running: `cd ~/anytype && docker compose ps`
- Restart if needed: `cd ~/anytype && docker compose restart`
- Verify the actual bridge gateway IP:
  ```bash
  docker network inspect bridge | grep Gateway
  ```
  If it differs from `172.18.0.1`, update both `ANYTYPE_HOST_IP` and
  `ANYTYPE_API_BASE_URL` in `.env` and re-run the Phase 5 helper.

---

## Phase 8 — Restart NanoClaw

**macOS (launchd):**
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Linux (systemd):**
```bash
systemctl --user restart nanoclaw
```

---

## Phase 9 — Test from a NanoClaw group

```
@Andy list my Anytype spaces
```

Expected: a list of your Anytype spaces by name.

```
@Andy search Anytype for "project plan"
```

Expected: matching objects with titles and space names.

---

## What agents can do after this skill

- **Global search** across all spaces
- **Space management** — list, create, update spaces and members
- **Object CRUD** — create, read, update, delete objects; set titles and properties
- **List management** — get list views, add/remove objects from lists
- **Properties & tags** — filter and sort by any property
- **Types & templates** — list and use object types and templates
- **Export** — export any object to Markdown

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Connection refused` on port 31012 | Anytype container not running | `cd ~/anytype && docker compose up -d` |
| `Connection refused` on port 47800 | Anytype media gateway not up | `cd ~/anytype && docker compose restart` |
| `401 Unauthorized` | Wrong or expired key | Generate a new key |
| Media URLs return 404 in container | Wrong bridge IP | Check with `docker network inspect bridge` |
| MCP tools not appearing | `.mcp.json` not saved | `cat .mcp.json` to verify |
| `Anytype-Version` mismatch warning | API version drift | Update header to current date string |

---

## Security notes

- The API key is stored in onecli and never written to disk — not in `.mcp.json`,
  not in `.env`, not in the wrapper script
- Ports `31012` and `47800` are bridged from the Anytype Docker Compose stack
  to `127.0.0.1` on the host — do not expose them externally without a reverse
  proxy and additional authentication. Check the port bindings with:
  `cd ~/anytype && docker compose port anytype 31012`
