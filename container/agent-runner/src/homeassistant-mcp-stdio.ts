/**
 * Stdio MCP Server for Home Assistant
 * Exposes the Home Assistant REST API as tools for the container agent.
 *
 * Auth:
 *   HA_URL=http://<host>:8123   (no trailing slash)
 *   HA_TOKEN=<long-lived access token>
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.HA_URL ?? '').replace(/\/$/, '');

async function apiGet(path: string): Promise<unknown> {
  const token = process.env.HA_TOKEN;
  if (!BASE || !token) throw new Error('HA_URL and HA_TOKEN must be set');
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const token = process.env.HA_TOKEN;
  if (!BASE || !token) throw new Error('HA_URL and HA_TOKEN must be set');
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

const mcpServer = new McpServer({ name: 'homeassistant', version: '1.0.0' });

mcpServer.tool(
  'ha_get_states',
  'List all entity states in Home Assistant. Optionally filter by domain (e.g. "light", "switch", "climate", "sensor"). Returns entity_id, state, attributes, and last_changed for each entity.',
  {
    domain: z.string().optional().describe('Filter by domain, e.g. "light", "switch", "climate", "sensor". Omit to return all entities.'),
  },
  async (args) => {
    try {
      const states = await apiGet('/api/states') as Array<{ entity_id: string }>;
      const filtered = args.domain
        ? states.filter(s => s.entity_id.startsWith(`${args.domain}.`))
        : states;
      return ok(filtered);
    } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'ha_get_state',
  'Get the current state of a specific Home Assistant entity by entity_id (e.g. "light.living_room", "climate.bedroom"). Returns state value, all attributes, and last_changed timestamp.',
  {
    entity_id: z.string().describe('Full entity ID, e.g. "light.living_room" or "sensor.temperature"'),
  },
  async (args) => {
    try { return ok(await apiGet(`/api/states/${args.entity_id}`)); } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'ha_call_service',
  'Call any Home Assistant service (e.g. turn on a light, set thermostat temperature, trigger a script). Returns the resulting state(s) of affected entities.',
  {
    domain: z.string().describe('Service domain, e.g. "light", "switch", "climate", "script"'),
    service: z.string().describe('Service name, e.g. "turn_on", "turn_off", "set_temperature"'),
    entity_id: z.string().optional().describe('Target entity ID, e.g. "light.living_room". Omit if the service does not target a specific entity.'),
    data: z.record(z.string(), z.unknown()).optional().describe('Additional service data as a JSON object, e.g. {"brightness": 128} or {"temperature": 21.5}'),
  },
  async (args) => {
    try {
      const body: Record<string, unknown> = { ...args.data };
      if (args.entity_id) body.entity_id = args.entity_id;
      return ok(await apiPost(`/api/services/${args.domain}/${args.service}`, body));
    } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'ha_list_automations',
  'List all automations in Home Assistant with their friendly name, current state (on/off), and last triggered timestamp.',
  {},
  async () => {
    try {
      const states = await apiGet('/api/states') as Array<{
        entity_id: string;
        state: string;
        attributes: Record<string, unknown>;
      }>;
      const automations = states
        .filter(s => s.entity_id.startsWith('automation.'))
        .map(s => ({
          entity_id: s.entity_id,
          friendly_name: s.attributes.friendly_name ?? s.entity_id,
          state: s.state,
          last_triggered: s.attributes.last_triggered ?? null,
        }));
      return ok(automations);
    } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'ha_get_history',
  'Get the state history for a specific entity over the last N hours. Useful for understanding recent changes, checking if a device was on/off at a particular time, or tracking sensor readings.',
  {
    entity_id: z.string().describe('Full entity ID to retrieve history for, e.g. "sensor.temperature"'),
    hours: z.number().int().min(1).max(168).default(24).describe('How many hours of history to retrieve (1–168, default 24)'),
  },
  async (args) => {
    try {
      const start = new Date(Date.now() - args.hours * 60 * 60 * 1000).toISOString();
      const url = `/api/history/period/${start}?filter_entity_id=${encodeURIComponent(args.entity_id)}&minimal_response=true`;
      return ok(await apiGet(url));
    } catch (e) { return err(e); }
  },
);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
