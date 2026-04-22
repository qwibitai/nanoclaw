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
const tailnet = encodeURIComponent((process.env.TS_API_TAILNET ?? '-').replace(/^@/, ''));

// --- Auth ---

interface TokenState {
  accessToken: string;
  expiresAt: number; // ms since epoch
}

let tokenState: TokenState | null = null;

async function getAccessToken(): Promise<string> {
  const apiKey = process.env.TS_API_KEY;
  if (apiKey) return apiKey;

  const clientId = process.env.TS_API_CLIENT_ID;
  const clientSecret = process.env.TS_API_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Either TS_API_KEY or TS_API_CLIENT_ID + TS_API_CLIENT_SECRET must be set');
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
