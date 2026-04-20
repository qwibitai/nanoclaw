import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

interface SearchResponse {
  ok?: boolean;
  items?: unknown[];
  error?: string;
  details?: string;
}

const configuredHost = process.env.YOUTUBE_HOST || 'http://host.docker.internal:3002';
const normalizedConfigured = configuredHost.replace(/\/$/, '');
const configuredUrl = new URL(normalizedConfigured);
const fallbackUrl = new URL(normalizedConfigured);
fallbackUrl.hostname = 'localhost';
const baseCandidates = Array.from(
  new Set([configuredUrl.toString(), fallbackUrl.toString()]),
);

async function requestJson<T>(
  method: 'GET' | 'POST',
  endpoint: string,
  body?: unknown,
): Promise<T> {
  let lastError: Error | null = null;
  for (const base of baseCandidates) {
    const url = `${base}${endpoint}`;
    try {
      const response = await fetch(url, {
        method,
        headers:
          method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      const payload = (await response.json()) as SearchResponse;
      if (!response.ok || payload?.ok === false) {
        throw new Error(
          payload?.details ||
            payload?.error ||
            `YouTube service request failed with ${response.status}`,
        );
      }
      return payload as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError || new Error('YouTube service request failed');
}

const server = new McpServer({
  name: 'youtube',
  version: '1.0.0',
});

const searchSchema = {
  query: z.string().describe('Search query text'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of results to return (default 20)'),
};

async function runSearch(args: { query: string; max_results?: number }) {
  const payload = await requestJson<{
    count: number;
    items: unknown[];
  }>('POST', '/api/search', {
    query: args.query,
    maxResults: args.max_results,
  });
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            count: payload.count,
            items: payload.items,
          },
          null,
          2,
        ),
      },
    ],
  };
}

const recentSchema = {
  max_results: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of results to return (default 20)'),
};

async function runRecent(args: { max_results?: number }) {
  const limit = args.max_results || 20;
  const payload = await requestJson<{
    count: number;
    items: unknown[];
  }>('GET', `/api/recent?limit=${encodeURIComponent(String(limit))}`);
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            count: payload.count,
            items: payload.items,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function runStatus() {
  const payload = await requestJson<{
    browserRunning: boolean;
    loggedIn: boolean;
    profileDir: string;
  }>('GET', '/api/status');
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

server.tool(
  'youtube_search_history',
  'Search YouTube watch history by query text and return matched watched videos.',
  searchSchema,
  runSearch,
);

// Backward-compatible alias.
server.tool(
  'search_history',
  'Search YouTube watch history by query text and return matched watched videos.',
  searchSchema,
  runSearch,
);

server.tool(
  'youtube_recent_history',
  'Fetch most recent YouTube watch history entries.',
  recentSchema,
  runRecent,
);

// Backward-compatible alias.
server.tool(
  'recent_history',
  'Fetch most recent YouTube watch history entries.',
  recentSchema,
  runRecent,
);

server.tool(
  'youtube_status',
  'Check YouTube history service status and whether login cookies are available.',
  {},
  runStatus,
);

// Backward-compatible alias.
server.tool(
  'status',
  'Check YouTube history service status and whether login cookies are available.',
  {},
  runStatus,
);

const transport = new StdioServerTransport();
await server.connect(transport);
