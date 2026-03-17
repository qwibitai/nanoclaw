/**
 * Stdio MCP Server for UnraidClaw
 * Wraps the UnraidClaw REST API for use as an MCP tool server.
 * Config: UNRAIDCLAW_URL (e.g. https://unraid-syd:9876), UNRAIDCLAW_API_KEY
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Skip TLS verification — UnraidClaw uses self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const baseUrl = (process.env.UNRAIDCLAW_URL ?? '').replace(/\/$/, '');
const apiKey = process.env.UNRAIDCLAW_API_KEY ?? '';

if (!baseUrl) {
  process.stderr.write('UNRAIDCLAW_URL is required\n');
  process.exit(1);
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'X-API-Key': apiKey },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

const server = new McpServer({
  name: 'unraidclaw',
  version: '1.0.0',
});

server.tool(
  'unraidclaw_health',
  'Check the health status of the UnraidClaw API server.',
  {},
  async () => {
    try {
      return ok(await apiGet('/api/health'));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  'unraidclaw_docker_list',
  'List all Docker containers managed by Unraid.',
  {},
  async () => {
    try {
      return ok(await apiGet('/api/docker/containers'));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  'unraidclaw_docker_get',
  'Get details for a specific Docker container.',
  {
    id: z.string().describe('Container ID or name'),
  },
  async (args) => {
    try {
      return ok(await apiGet(`/api/docker/containers/${args.id}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  'unraidclaw_docker_logs',
  'Fetch logs for a specific Docker container.',
  {
    id: z.string().describe('Container ID or name'),
    tail: z.number().optional().describe('Number of lines from the end (omit for all)'),
  },
  async (args) => {
    try {
      const query = args.tail !== undefined ? `?tail=${args.tail}` : '';
      return ok(await apiGet(`/api/docker/containers/${args.id}/logs${query}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  'unraidclaw_docker_action',
  'Perform an action on a Docker container.',
  {
    id: z.string().describe('Container ID or name'),
    action: z.enum(['start', 'stop', 'restart', 'pause']).describe('Action to perform'),
  },
  async (args) => {
    try {
      return ok(await apiPost(`/api/docker/containers/${args.id}/${args.action}`));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  'unraidclaw_array_status',
  'Get the current Unraid array status: started/stopped state, disk states, parity info.',
  {},
  async () => {
    try {
      return ok(await apiGet('/api/array/status'));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  'unraidclaw_system_info',
  'Get static system information: hostname, OS version, CPU, memory, uptime.',
  {},
  async () => {
    try {
      return ok(await apiGet('/api/system/info'));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  'unraidclaw_system_metrics',
  'Get live system metrics: CPU usage, memory usage, network I/O, temperatures.',
  {},
  async () => {
    try {
      return ok(await apiGet('/api/system/metrics'));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  'unraidclaw_notifications_list',
  'List Unraid notifications.',
  {},
  async () => {
    try {
      return ok(await apiGet('/api/notifications'));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  'unraidclaw_notification_create',
  'Create a new Unraid notification.',
  {
    subject: z.string().describe('Notification subject/title'),
    description: z.string().describe('Notification body text'),
    importance: z.enum(['normal', 'warning', 'alert']).optional().describe('Severity (default: normal)'),
  },
  async (args) => {
    try {
      return ok(await apiPost('/api/notifications', args));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  'unraidclaw_logs_syslog',
  'Fetch lines from the Unraid syslog.',
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
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  'unraidclaw_disks',
  'List all disks in the Unraid system with health and SMART data.',
  {},
  async () => {
    try {
      return ok(await apiGet('/api/disks'));
    } catch (e) {
      return err(e);
    }
  },
);

server.tool(
  'unraidclaw_shares',
  'List all Unraid user shares.',
  {},
  async () => {
    try {
      return ok(await apiGet('/api/shares'));
    } catch (e) {
      return err(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
