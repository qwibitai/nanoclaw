/**
 * Peer MCP Server — NanoClaw-to-NanoClaw messaging from inside containers.
 *
 * Exposes two tools to the container agent:
 *   peer_list  — list configured peers and their online status
 *   peer_send  — send a text or JSON message to a named peer
 *
 * Reads peer config from environment variables set by the host:
 *   PEER_NAME     — this instance's name
 *   PEER_API_TOKEN — shared Bearer token
 *   PEER_TARGETS  — comma-separated "name=url" pairs
 */

import http from 'http';
import https from 'https';
import { URL } from 'url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const PEER_NAME = process.env.PEER_NAME || '';
const PEER_API_TOKEN = process.env.PEER_API_TOKEN || '';
const PEER_TARGETS_RAW = process.env.PEER_TARGETS || '';

interface PeerTarget {
  name: string;
  url: string;
}

function parsePeerTargets(raw: string): PeerTarget[] {
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf('=');
      if (idx < 1) return null;
      const name = entry.slice(0, idx).trim().toLowerCase();
      const url = entry.slice(idx + 1).trim();
      return name && url ? { name, url } : null;
    })
    .filter((t): t is PeerTarget => t !== null);
}

const targets = parsePeerTargets(PEER_TARGETS_RAW);

function peerLog(msg: string): void {
  process.stderr.write(`[PEER] ${msg}\n`);
}

/** HTTP/HTTPS GET helper, returns parsed JSON or null. */
async function getJson<T>(url: string, timeoutMs = 5000): Promise<T | null> {
  return new Promise((resolve) => {
    let timedOut = false;
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (!timedOut) {
            try { resolve(JSON.parse(data) as T); } catch { resolve(null); }
          }
        });
      },
    );
    req.on('error', () => { if (!timedOut) resolve(null); });
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      resolve(null);
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
  });
}

/** HTTP/HTTPS POST helper, returns {ok, status, body}. */
async function postJson(
  url: string,
  token: string,
  body: object,
  timeoutMs = 10000,
): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    let timedOut = false;
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Authorization: `Bearer ${token}`,
      },
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (!timedOut) resolve({ ok: res.statusCode === 200, status: res.statusCode ?? 0, body: data });
      });
    });
    req.on('error', (err) => {
      if (!timedOut) resolve({ ok: false, status: 0, body: err.message });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      resolve({ ok: false, status: 0, body: 'timeout' });
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.write(payload);
    req.end();
  });
}

const server = new McpServer({
  name: 'nanoclaw-peer',
  version: '1.0.0',
});

server.tool(
  'peer_list',
  'List all configured peer NanoClaw instances and check which ones are reachable.',
  {},
  async () => {
    if (targets.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No peer targets configured. Set PEER_TARGETS in .env.' }] };
    }

    const rows = await Promise.all(
      targets.map(async (t) => {
        const health = await getJson<{ ok: boolean; name?: string }>(`${t.url}/peer/health`);
        const status = health?.ok ? 'online' : 'offline';
        const remoteName = health?.name ? ` (${health.name})` : '';
        return `  ${t.name}${remoteName}: ${status}  [${t.url}]`;
      }),
    );

    peerLog(`Listed ${targets.length} peer(s)`);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Configured peers:\n${rows.join('\n')}\n\nThis instance: ${PEER_NAME || '(unnamed)'}`,
        },
      ],
    };
  },
);

server.tool(
  'peer_send',
  'Send a message to a named peer NanoClaw instance. Content can be plain text or a JSON string for structured data exchange. The peer\'s agent will receive and process the message in its peer group.',
  {
    name: z.string().describe('Peer name as configured in PEER_TARGETS (e.g. "bob")'),
    content: z.string().describe('Message content — plain text or a JSON string for structured data'),
  },
  async (args: { name: string; content: string }) => {
    const target = targets.find((t) => t.name === args.name.toLowerCase());
    if (!target) {
      const available = targets.map((t) => t.name).join(', ') || 'none';
      return {
        content: [
          {
            type: 'text' as const,
            text: `Unknown peer: "${args.name}". Available: ${available}`,
          },
        ],
      };
    }

    const body = {
      from: PEER_NAME,
      content: args.content,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
    };

    peerLog(`Sending message to ${target.name} (${args.content.length} chars)`);
    const result = await postJson(`${target.url}/peer/message`, PEER_API_TOKEN, body);

    if (result.ok) {
      peerLog(`Message delivered to ${target.name}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Message delivered to ${target.name}.`,
          },
        ],
      };
    } else {
      peerLog(`Failed to deliver to ${target.name}: status=${result.status} body=${result.body}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to deliver message to ${target.name} (HTTP ${result.status}): ${result.body}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
