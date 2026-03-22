/**
 * Stdio MCP Server for UnraidClaw
 * Wraps the UnraidClaw REST API for use as an MCP tool server.
 *
 * Multi-server config (preferred):
 *   UNRAIDCLAW_SERVERS='[{"name":"unraid-syd","url":"https://unraid-syd:9876","apiKey":"..."}]'
 *
 * Single-server config (backward compat):
 *   UNRAIDCLAW_URL=https://unraid-syd:9876
 *   UNRAIDCLAW_API_KEY=...
 *   (treated as a single server named "default")
 *
 * Tool names are prefixed with the sanitized server name (hyphens → underscores):
 *   unraidclaw_<name>__health, unraidclaw_<name>__docker_list, etc.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Skip TLS verification — UnraidClaw uses self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

interface ServerConfig {
  name: string;
  url: string;
  apiKey: string;
}

function sanitizeName(name: string): string {
  return name.replace(/-/g, '_');
}

function loadServers(): ServerConfig[] {
  const raw = process.env.UNRAIDCLAW_SERVERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ServerConfig[];
      if (!Array.isArray(parsed) || parsed.length === 0) {
        process.stderr.write('UNRAIDCLAW_SERVERS must be a non-empty JSON array\n');
        process.exit(1);
      }
      return parsed;
    } catch {
      process.stderr.write('Failed to parse UNRAIDCLAW_SERVERS as JSON\n');
      process.exit(1);
    }
  }

  const url = (process.env.UNRAIDCLAW_URL ?? '').replace(/\/$/, '');
  const apiKey = process.env.UNRAIDCLAW_API_KEY ?? '';
  if (!url) {
    process.stderr.write('Either UNRAIDCLAW_SERVERS or UNRAIDCLAW_URL is required\n');
    process.exit(1);
  }
  return [{ name: 'default', url, apiKey }];
}

const servers = loadServers();

function makeApi(config: ServerConfig) {
  const base = config.url.replace(/\/$/, '');
  const headers = { 'X-API-Key': config.apiKey };

  async function apiGet(path: string): Promise<unknown> {
    const res = await fetch(`${base}${path}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async function apiPost(path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  return { apiGet, apiPost };
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

const mcpServer = new McpServer({ name: 'unraidclaw', version: '2.0.0' });

function registerServerTools(config: ServerConfig) {
  const { apiGet, apiPost } = makeApi(config);
  const p = `unraidclaw_${sanitizeName(config.name)}__`;
  const s = config.name;

  mcpServer.tool(
    `${p}health`,
    `[${s}] Check the health status of the UnraidClaw API server.`,
    {},
    async () => {
      try { return ok(await apiGet('/api/health')); } catch (e) { return err(e); }
    },
  );

  mcpServer.tool(
    `${p}docker_list`,
    `[${s}] List all Docker containers managed by Unraid.`,
    {},
    async () => {
      try { return ok(await apiGet('/api/docker/containers')); } catch (e) { return err(e); }
    },
  );

  mcpServer.tool(
    `${p}docker_get`,
    `[${s}] Get details for a specific Docker container.`,
    { id: z.string().describe('Container ID or name') },
    async (args) => {
      try { return ok(await apiGet(`/api/docker/containers/${args.id}`)); } catch (e) { return err(e); }
    },
  );

  mcpServer.tool(
    `${p}docker_logs`,
    `[${s}] Fetch logs for a specific Docker container.`,
    {
      id: z.string().describe('Container ID or name'),
      tail: z.number().optional().describe('Number of lines from the end (omit for all)'),
    },
    async (args) => {
      try {
        const query = args.tail !== undefined ? `?tail=${args.tail}` : '';
        return ok(await apiGet(`/api/docker/containers/${args.id}/logs${query}`));
      } catch (e) { return err(e); }
    },
  );

  mcpServer.tool(
    `${p}docker_action`,
    `[${s}] Perform an action on a Docker container.`,
    {
      id: z.string().describe('Container ID or name'),
      action: z.enum(['start', 'stop', 'restart', 'pause']).describe('Action to perform'),
    },
    async (args) => {
      try { return ok(await apiPost(`/api/docker/containers/${args.id}/${args.action}`)); } catch (e) { return err(e); }
    },
  );

  mcpServer.tool(
    `${p}array_status`,
    `[${s}] Get the current Unraid array status: started/stopped state, disk states, parity info.`,
    {},
    async () => {
      try { return ok(await apiGet('/api/array/status')); } catch (e) { return err(e); }
    },
  );

  mcpServer.tool(
    `${p}system_info`,
    `[${s}] Get static system information: hostname, OS version, CPU, memory, uptime.`,
    {},
    async () => {
      try { return ok(await apiGet('/api/system/info')); } catch (e) { return err(e); }
    },
  );

  mcpServer.tool(
    `${p}system_metrics`,
    `[${s}] Get live system metrics: CPU usage, memory usage, network I/O, temperatures.`,
    {},
    async () => {
      try { return ok(await apiGet('/api/system/metrics')); } catch (e) { return err(e); }
    },
  );

  mcpServer.tool(
    `${p}notifications_list`,
    `[${s}] List Unraid notifications.`,
    {},
    async () => {
      try { return ok(await apiGet('/api/notifications')); } catch (e) { return err(e); }
    },
  );

  mcpServer.tool(
    `${p}notification_create`,
    `[${s}] Create a new Unraid notification.`,
    {
      subject: z.string().describe('Notification subject/title'),
      description: z.string().describe('Notification body text'),
      importance: z.enum(['normal', 'warning', 'alert']).optional().describe('Severity (default: normal)'),
    },
    async (args) => {
      try { return ok(await apiPost('/api/notifications', args)); } catch (e) { return err(e); }
    },
  );

  mcpServer.tool(
    `${p}logs_syslog`,
    `[${s}] Fetch lines from the Unraid syslog.`,
    {
      tail: z.number().optional().describe('Number of lines from the end (omit for all)'),
      filter: z.string().optional().describe('Filter string to grep for'),
    },
    async (args) => {
      try {
        const params = new URLSearchParams();
        if (args.tail !== undefined) params.set('tail', String(args.tail));
        if (args.filter !== undefined) params.set('filter', args.filter);
        const query = params.size > 0 ? `?${params}` : '';
        return ok(await apiGet(`/api/logs/syslog${query}`));
      } catch (e) { return err(e); }
    },
  );

  mcpServer.tool(
    `${p}disks`,
    `[${s}] List all disks with health and SMART data.`,
    {},
    async () => {
      try { return ok(await apiGet('/api/disks')); } catch (e) { return err(e); }
    },
  );

  mcpServer.tool(
    `${p}shares`,
    `[${s}] List all Unraid user shares.`,
    {},
    async () => {
      try { return ok(await apiGet('/api/shares')); } catch (e) { return err(e); }
    },
  );
}

// Register per-server tools
for (const config of servers) {
  registerServerTools(config);
}

// Aggregate: list all configured servers
mcpServer.tool(
  'unraidclaw_list_servers',
  'List all configured Unraid servers (name and URL).',
  {},
  async () => {
    return ok(servers.map(s => ({ name: s.name, url: s.url })));
  },
);

// Aggregate: list Docker containers across all servers
mcpServer.tool(
  'unraidclaw_all_docker_list',
  'List Docker containers across all configured Unraid servers, labelled by server name.',
  {},
  async () => {
    const results = await Promise.allSettled(
      servers.map(async (config) => {
        const { apiGet } = makeApi(config);
        const containers = await apiGet('/api/docker/containers');
        return { server: config.name, containers };
      }),
    );

    const output = results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      return { server: servers[i].name, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
    });

    return ok(output);
  },
);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
