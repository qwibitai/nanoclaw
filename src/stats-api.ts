import { createServer, Server } from 'http';

import {
  getTokenUsageByContainer,
  getTokenUsageByGroup,
  getTokenUsageSummary,
  getTokenUsageTimeSeries,
} from './db.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';

// Model pricing per million tokens (USD)
const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-sonnet-4-20250514': {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  'claude-opus-4-20250514': {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
  },
  'claude-haiku-4-20250414': {
    input: 0.8,
    output: 4,
    cacheRead: 0.08,
    cacheWrite: 1,
  },
};

// Default pricing if model not recognised
const DEFAULT_PRICING = MODEL_PRICING['claude-sonnet-4-20250514'];

function estimateCost(summary: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}): number {
  const p = DEFAULT_PRICING;
  return (
    (summary.input_tokens / 1_000_000) * p.input +
    (summary.output_tokens / 1_000_000) * p.output +
    (summary.cache_read_input_tokens / 1_000_000) * p.cacheRead +
    (summary.cache_creation_input_tokens / 1_000_000) * p.cacheWrite
  );
}

function parseSince(since: string | null): string | undefined {
  if (!since) return undefined;
  // Relative shorthand: 1h, 24h, 7d
  const match = since.match(/^(\d+)([hd])$/);
  if (match) {
    const amount = parseInt(match[1], 10);
    const unit = match[2];
    const ms = unit === 'h' ? amount * 3600000 : amount * 86400000;
    return new Date(Date.now() - ms).toISOString();
  }
  // Otherwise treat as ISO date
  return since;
}

function json(res: import('http').ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res: import('http').ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

export interface StatsApiContext {
  queue: GroupQueue;
  getRegisteredGroups: () => Record<string, { name: string; folder: string }>;
  startTime: number;
}

export function startStatsApi(
  port: number,
  ctx: StatsApiContext,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const path = url.pathname;
      const since = parseSince(url.searchParams.get('since'));
      const group = url.searchParams.get('group') || undefined;

      try {
        if (path === '/api/status') {
          const groups = ctx.getRegisteredGroups();
          const status = ctx.queue.getStatus();
          json(res, {
            uptime_seconds: Math.floor((Date.now() - ctx.startTime) / 1000),
            active_containers: status.activeCount,
            max_concurrent_containers: status.maxConcurrent,
            registered_groups: Object.values(groups).map((g) => ({
              name: g.name,
              folder: g.folder,
            })),
          });
        } else if (path === '/api/stats/summary') {
          const summary = getTokenUsageSummary({
            since,
            groupFolder: group,
          });
          json(res, {
            since: since || 'all',
            ...summary,
            estimated_cost_usd: Math.round(estimateCost(summary) * 100) / 100,
          });
        } else if (path === '/api/stats/by-group') {
          const groups = getTokenUsageByGroup(since);
          json(res, {
            since: since || 'all',
            groups: groups.map((g) => ({
              ...g,
              estimated_cost_usd: Math.round(estimateCost(g) * 100) / 100,
            })),
          });
        } else if (path === '/api/stats/timeline') {
          const bucket =
            (url.searchParams.get('bucket') as 'hour' | 'day') || 'hour';
          const buckets = getTokenUsageTimeSeries({
            since,
            groupFolder: group,
            bucket,
          });
          json(res, { since: since || 'all', bucket, buckets });
        } else if (path === '/api/stats/containers') {
          const limit = parseInt(url.searchParams.get('limit') || '20', 10);
          const containers = getTokenUsageByContainer({
            since,
            groupFolder: group,
            limit,
          });
          json(res, { since: since || 'all', containers });
        } else {
          notFound(res);
        }
      } catch (err) {
        logger.error({ err, path }, 'Stats API error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });

    server.listen(port, '127.0.0.1', () => {
      logger.info({ port }, 'Stats API started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
