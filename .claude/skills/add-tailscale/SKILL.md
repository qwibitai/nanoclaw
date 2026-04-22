---
name: add-tailscale
description: Add Tailscale API integration to NanoClaw. Lets the container agent discover tailnet devices, inspect routes, read ACL policy, and run ACL security audits using the Tailscale API v2. Supports both OAuth client credentials and personal API keys.
---

# Add Tailscale Integration

This skill adds a stdio-based MCP server that exposes the Tailscale API v2 as tools for the container agent.

Tools added:
- `tailscale_list_devices` — list all tailnet devices with IPs, OS, tags, and online status
- `tailscale_get_device` — get full details for a specific device by ID
- `tailscale_get_device_routes` — get advertised and approved subnet routes for a device
- `tailscale_get_acl` — fetch the live ACL policy as JSON
- `tailscale_audit_acl` — fetch the ACL and run basic security checks (wildcards, unowned tags, open ports, missing posture)
- `tailscale_list_auth_keys` — list authentication keys with expiry and capability info
- `tailscale_get_dns_config` — get nameservers, search paths, and MagicDNS preferences
- `tailscale_get_settings` — get tailnet-wide feature and routing settings

All tool calls from the agent use the MCP prefix: `mcp__tailscale__tailscale_<tool>`

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/tailscale-mcp-stdio.ts` already exists. If it does, skip to Phase 3 (Configure).

### Collect credentials

Use `AskUserQuestion` to determine the auth method:

> How would you like to authenticate with the Tailscale API?
>
> **Option A — OAuth client credentials (recommended):** Create an OAuth client at https://login.tailscale.com/admin/settings/oauth with at least these read scopes: `devices`, `acls`, `auth_keys`, `dns`, `settings`. You will get a Client ID and Client Secret.
>
> **Option B — Personal API key:** Create a key at https://login.tailscale.com/admin/settings/keys. Copy the key (starts with `tskey-api-`).

Collect the credentials now (client_id + client_secret for OAuth, or key for API key).

Then ask for the tailnet identifier:

> What is your tailnet identifier? This is usually your organization's domain name (e.g. `example.com`) or `-` to use your personal/default tailnet. Check https://login.tailscale.com/admin/dns — it shows your tailnet name near the top.

Default is `-`.

### Test API connectivity

**For OAuth** — exchange credentials for a token:

```bash
curl -s -X POST https://api.tailscale.com/api/v2/oauth/token \
  -d "grant_type=client_credentials&client_id=<CLIENT_ID>&client_secret=<CLIENT_SECRET>"
```

Parse the response and extract `access_token`. Then test with it:

```bash
curl -s -H "Authorization: Bearer <ACCESS_TOKEN>" \
  "https://api.tailscale.com/api/v2/tailnet/<TAILNET>/devices" | head -c 500
```

**For API key:**

```bash
curl -s -H "Authorization: Bearer <API_KEY>" \
  "https://api.tailscale.com/api/v2/tailnet/<TAILNET>/devices" | head -c 500
```

The response must be valid JSON and contain a `devices` array. If the request fails (401/403), stop and tell the user to check their credentials and that the correct scopes are granted. Do not proceed until the test passes.

## Phase 2: Apply Code Changes

### Write the MCP server

Create `container/agent-runner/src/tailscale-mcp-stdio.ts` with exactly the following content:

```typescript
/**
 * Stdio MCP Server for Tailscale
 * Exposes Tailscale API v2 as tools for the container agent.
 *
 * Auth (pick one):
 *   OAuth (recommended):
 *     TAILSCALE_CLIENT_ID=<oauth-client-id>
 *     TAILSCALE_CLIENT_SECRET=<oauth-client-secret>
 *   API key:
 *     TAILSCALE_API_KEY=<tskey-api-...>
 *
 * Tailnet identifier (usually `-` for the default tailnet):
 *   TAILSCALE_TAILNET=-
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = 'https://api.tailscale.com';
const tailnet = encodeURIComponent((process.env.TAILSCALE_TAILNET ?? '-').replace(/^@/, ''));

// --- Auth ---

interface TokenState {
  accessToken: string;
  expiresAt: number; // ms since epoch
}

let tokenState: TokenState | null = null;

async function getAccessToken(): Promise<string> {
  const apiKey = process.env.TAILSCALE_API_KEY;
  if (apiKey) return apiKey;

  const clientId = process.env.TAILSCALE_CLIENT_ID;
  const clientSecret = process.env.TAILSCALE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Either TAILSCALE_API_KEY or TAILSCALE_CLIENT_ID + TAILSCALE_CLIENT_SECRET must be set');
  }

  // Return cached token if still valid (with 60s buffer)
  if (tokenState && Date.now() < tokenState.expiresAt - 60_000) {
    return tokenState.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(`${BASE}/api/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: HTTP ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  tokenState = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return tokenState.accessToken;
}

async function apiGet(path: string, accept?: string): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(accept ? { Accept: accept } : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(e: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true as const,
  };
}

// --- MCP Server ---

const mcpServer = new McpServer({ name: 'tailscale', version: '1.0.0' });

mcpServer.tool(
  'tailscale_list_devices',
  'List all devices in the tailnet. Returns device ID, hostname, Tailscale IP addresses, OS, owner, tags, last-seen time, and online/offline status.',
  {
    fields: z.string().optional().describe('Comma-separated extra fields to include (e.g. "clientConnectivity,clientVersion")'),
  },
  async (args) => {
    try {
      const query = args.fields ? `?fields=${encodeURIComponent(args.fields)}` : '';
      return ok(await apiGet(`/api/v2/tailnet/${tailnet}/devices${query}`));
    } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'tailscale_get_device',
  'Get full details for a specific device by its Tailscale device ID.',
  {
    deviceId: z.string().describe('Tailscale device ID (numeric string, found in tailscale_list_devices output)'),
    fields: z.string().optional().describe('Comma-separated extra fields to include'),
  },
  async (args) => {
    try {
      const query = args.fields ? `?fields=${encodeURIComponent(args.fields)}` : '';
      return ok(await apiGet(`/api/v2/device/${args.deviceId}${query}`));
    } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'tailscale_get_device_routes',
  'Get subnet routes advertised and approved for a specific device.',
  {
    deviceId: z.string().describe('Tailscale device ID'),
  },
  async (args) => {
    try { return ok(await apiGet(`/api/v2/device/${args.deviceId}/routes`)); } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'tailscale_get_acl',
  'Get the current ACL policy for the tailnet as JSON. Includes access rules, groups, tag owners, hosts, posture checks, and SSH rules.',
  {},
  async () => {
    try { return ok(await apiGet(`/api/v2/tailnet/${tailnet}/acl`, 'application/json')); } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'tailscale_audit_acl',
  'Fetch the live ACL and run basic security checks: wildcard src/dst rules, unowned tags, all-ports grants, empty groups, and missing posture configuration.',
  {},
  async () => {
    try {
      const acl = await apiGet(`/api/v2/tailnet/${tailnet}/acl`, 'application/json') as Record<string, unknown>;
      const findings: string[] = [];

      const aclRules = (acl.acls ?? []) as Array<{ action?: string; src?: string[]; dst?: string[] }>;
      for (const rule of aclRules) {
        const srcs = rule.src ?? [];
        const dsts = rule.dst ?? [];
        if (srcs.includes('*') && dsts.some(d => d.startsWith('*'))) {
          findings.push(`WARN: Fully open rule — any source can reach any destination: ${JSON.stringify(rule)}`);
        } else if (srcs.includes('*')) {
          findings.push(`INFO: Rule allows any device as source: ${JSON.stringify(rule)}`);
        }
        if (dsts.some(d => d.endsWith(':*') || d.endsWith(':0'))) {
          findings.push(`INFO: Rule grants access to all ports on a destination: ${JSON.stringify(rule)}`);
        }
      }

      const groups = (acl.groups ?? {}) as Record<string, string[]>;
      for (const [group, members] of Object.entries(groups)) {
        if (members.length === 0) {
          findings.push(`INFO: Group "${group}" has no members`);
        }
      }

      const tagOwners = (acl.tagOwners ?? {}) as Record<string, string[]>;
      const tags = Object.keys(tagOwners);
      if (tags.length === 0) {
        findings.push('INFO: No tag owners defined — all tags are unowned (any authenticated user can self-assign them)');
      } else {
        for (const [tag, owners] of Object.entries(tagOwners)) {
          if (owners.length === 0) {
            findings.push(`WARN: Tag "${tag}" has no owners — any authenticated user can apply this tag`);
          }
        }
      }

      const hasPosture = !!(acl.nodeAttrs || (acl as Record<string, unknown>).posture);
      if (!hasPosture) {
        findings.push('INFO: No device posture checks (nodeAttrs) defined');
      }

      const ssh = (acl.ssh ?? []) as Array<{ action?: string; src?: string[]; dst?: string[] }>;
      for (const rule of ssh) {
        if ((rule.src ?? []).includes('*') || (rule.dst ?? []).includes('*')) {
          findings.push(`WARN: SSH rule has wildcard src or dst: ${JSON.stringify(rule)}`);
        }
      }

      return ok({
        summary: findings.length === 0 ? 'No issues found' : `${findings.length} finding(s)`,
        findings,
        acl,
      });
    } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'tailscale_list_auth_keys',
  'List authentication keys for the tailnet. Returns key ID, description, expiry date, reusable flag, ephemeral flag, and capabilities.',
  {},
  async () => {
    try { return ok(await apiGet(`/api/v2/tailnet/${tailnet}/keys`)); } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'tailscale_get_dns_config',
  'Get the DNS configuration for the tailnet: nameservers, search paths, and MagicDNS preferences.',
  {},
  async () => {
    try {
      const [nameservers, searchpaths, preferences] = await Promise.all([
        apiGet(`/api/v2/tailnet/${tailnet}/dns/nameservers`),
        apiGet(`/api/v2/tailnet/${tailnet}/dns/searchpaths`),
        apiGet(`/api/v2/tailnet/${tailnet}/dns/preferences`),
      ]);
      return ok({ nameservers, searchpaths, preferences });
    } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'tailscale_get_settings',
  'Get tailnet-wide settings: features enabled, device approval, posture integration, logging, and routing configuration.',
  {},
  async () => {
    try { return ok(await apiGet(`/api/v2/tailnet/${tailnet}/settings`)); } catch (e) { return err(e); }
  },
);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
```

### Wire into agent-runner index.ts

Open `container/agent-runner/src/index.ts` and make four edits:

**1. Add path variable** — immediately after the `unraidclawMcpServerPath` line, add:

```typescript
const tailscaleMcpServerPath = path.join(__dirname, 'tailscale-mcp-stdio.js');
```

**2. Add to `runQuery` function signature** — in the `runQuery` function parameters, after `unraidclawMcpServerPath: string`, add:

```typescript
tailscaleMcpServerPath: string,
```

**3. Add to `allowedTools`** — in the `allowedTools` array, after `'mcp__unraidclaw__*'`, add:

```typescript
'mcp__tailscale__*',
```

**4. Add to `mcpServers`** — inside the `mcpServers` object, after the closing brace of the `unraidclaw` entry, add:

```typescript
tailscale: {
  command: 'node',
  args: [tailscaleMcpServerPath],
  env: {
    TAILSCALE_API_KEY: sdkEnv.TAILSCALE_API_KEY ?? '',
    TAILSCALE_CLIENT_ID: sdkEnv.TAILSCALE_CLIENT_ID ?? '',
    TAILSCALE_CLIENT_SECRET: sdkEnv.TAILSCALE_CLIENT_SECRET ?? '',
    TAILSCALE_TAILNET: sdkEnv.TAILSCALE_TAILNET ?? '-',
  },
},
```

**5. Update the `runQuery` call site** — find the call to `runQuery(...)` in `main()` (it passes `unraidclawMcpServerPath`) and add `tailscaleMcpServerPath` after it:

```typescript
// Before:
const queryResult = await runQuery(prompt, sessionId, mcpServerPath, unraidclawMcpServerPath, containerInput, sdkEnv, resumeAt);
// After:
const queryResult = await runQuery(prompt, sessionId, mcpServerPath, unraidclawMcpServerPath, tailscaleMcpServerPath, containerInput, sdkEnv, resumeAt);
```

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Update them:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/tailscale-mcp-stdio.ts "$dir/"
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

The main NanoClaw process passes environment variables to agent containers explicitly. Open `src/container-runner.ts` and add the following four blocks immediately after the `UNRAIDCLAW_API_KEY` block:

```typescript
  if (process.env.TAILSCALE_API_KEY) {
    args.push('-e', `TAILSCALE_API_KEY=${process.env.TAILSCALE_API_KEY}`);
  }
  if (process.env.TAILSCALE_CLIENT_ID) {
    args.push('-e', `TAILSCALE_CLIENT_ID=${process.env.TAILSCALE_CLIENT_ID}`);
  }
  if (process.env.TAILSCALE_CLIENT_SECRET) {
    args.push('-e', `TAILSCALE_CLIENT_SECRET=${process.env.TAILSCALE_CLIENT_SECRET}`);
  }
  if (process.env.TAILSCALE_TAILNET) {
    args.push('-e', `TAILSCALE_TAILNET=${process.env.TAILSCALE_TAILNET}`);
  }
```

Without this step the Tailscale MCP server will start but will have no credentials and all tool calls will fail.

## Phase 3: Configure

### Configure environment variables

On Unraid/Docker deployments: add the variables directly to the NanoClaw container template via the Unraid Docker UI (edit container → add variables). The credential proxy passes them to child containers automatically.

On standard Linux/macOS deployments: append to `.env` and sync:

**OAuth credentials:**
```bash
TAILSCALE_CLIENT_ID=<oauth-client-id>
TAILSCALE_CLIENT_SECRET=<oauth-client-secret>
TAILSCALE_TAILNET=<tailnet-or-dash>
```

**API key:**
```bash
TAILSCALE_API_KEY=<tskey-api-...>
TAILSCALE_TAILNET=<tailnet-or-dash>
```

Then sync:
```bash
cp .env data/env/env
```

Also add placeholder entries to `.env.example` if not already present:

```bash
TAILSCALE_API_KEY=
TAILSCALE_CLIENT_ID=
TAILSCALE_CLIENT_SECRET=
TAILSCALE_TAILNET=
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

> Send a message like: "list my tailscale devices"
>
> The agent should call `mcp__tailscale__tailscale_list_devices` and return the device list.
>
> To run an ACL audit: "audit my tailscale ACL for security issues"
> The agent will call `mcp__tailscale__tailscale_audit_acl` and summarize any findings.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i tailscale
```

Look for tool calls like `mcp__tailscale__tailscale_list_devices` appearing in agent output.

## Troubleshooting

### "Either TAILSCALE_API_KEY or TAILSCALE_CLIENT_ID + TAILSCALE_CLIENT_SECRET must be set"

The env vars are not reaching the container agent. Check:
1. The vars are in `.env` AND synced to `data/env/env` (`cp .env data/env/env`)
2. The `tailscale` entry in `mcpServers` passes all four env vars
3. The service was restarted after the `.env` change

### OAuth token exchange fails (401/403)

1. Verify the client ID and secret are correct (no extra whitespace)
2. Confirm the OAuth client was created at https://login.tailscale.com/admin/settings/oauth (not the API keys page)
3. Check that the required scopes (`devices:read`, `acls:read`, etc.) are granted on the OAuth client

### API key fails (403 Forbidden)

The key may lack the required capabilities. Personal API keys at https://login.tailscale.com/admin/settings/keys have full access by default. OAuth keys are scoped — verify at https://login.tailscale.com/admin/settings/oauth.

### Agent doesn't use Tailscale tools

1. Check `container/agent-runner/src/index.ts` has `'mcp__tailscale__*'` in `allowedTools`
2. Check the `tailscale` entry is in `mcpServers` with all four env vars
3. Verify the per-group source was updated (see Phase 2)
4. Confirm the container image was rebuilt with `./container/build.sh`
5. Try being explicit: "use the tailscale_list_devices tool to show my tailnet"

### Tailscale tools return "credentials not set" but env vars are configured

The TAILSCALE_* vars are set in the NanoClaw container but not being forwarded to agent containers. Verify `src/container-runner.ts` has the four TAILSCALE passthrough blocks from Phase 2b. If missing, add them and rebuild: `npm run build` then rebuild and push the main NanoClaw image.

### Agent runner won't start after changes

Check for TypeScript errors:

```bash
cd container/agent-runner && npx tsc --noEmit
```

Common cause: `tailscaleMcpServerPath` parameter added to signature but not to the call site (or vice versa).

### Device list is empty

If your tailnet has devices but the list is empty, check the tailnet identifier. Use `-` for your personal tailnet. For org tailnets, the identifier is the domain shown at https://login.tailscale.com/admin/dns.

## Removal

To remove the Tailscale integration:

1. Delete `container/agent-runner/src/tailscale-mcp-stdio.ts`
2. Remove the `tailscaleMcpServerPath` variable, `tailscaleMcpServerPath` parameter, `'mcp__tailscale__*'` from `allowedTools`, and the `tailscale` entry from `mcpServers` in `container/agent-runner/src/index.ts`
3. Remove `TAILSCALE_*` vars from `.env` and sync: `cp .env data/env/env`
4. Remove placeholder lines from `.env.example`
5. Rebuild: `npm run build && ./container/build.sh`
6. Restart:
```bash
docker restart NanoClaw  # Unraid/Docker
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux: systemctl --user restart nanoclaw
```
