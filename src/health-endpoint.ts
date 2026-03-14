/**
 * Minimal HTTP health endpoint. Returns JSON on GET /health.
 * Uses Node built-in http module — no new dependencies.
 */
import http from 'http';

import { logger } from './logger.js';

export interface PipelineStats {
  inboundProcessed: number;
  inboundRejected: number;
  outboundProcessed: number;
  outboundSuppressed: number;
}

export interface HealthStatus {
  uptime: number;
  channels: Record<string, 'up' | 'down'>;
  activeGroups: number;
  dailySpend: number;
  pipelineStats: PipelineStats;
}

export function startHealthServer(opts: {
  port?: number;
  getStatus: () => HealthStatus;
}): void {
  const port = opts.port ?? 9090;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/health/')) {
      const status = opts.getStatus();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(JSON.stringify(status));
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, () => {
    logger.info({ port }, 'Health endpoint listening');
  });

  server.on('error', (err) => {
    logger.error({ err, port }, 'Health endpoint failed to start');
  });
}
