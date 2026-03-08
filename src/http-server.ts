import http from 'node:http';
import { createRequire } from 'node:module';

import { logger } from './logger.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const IDENTITY_RESPONSE = JSON.stringify({
  implementation: 'nanoclaw',
  version,
  protocol: 'clawlink/1.0',
});

const HEALTH_RESPONSE = JSON.stringify({
  status: 'ok',
  framework: 'nanoclaw',
  version,
});

/**
 * Start a lightweight HTTP server that exposes:
 *   - `/.well-known/claw-identity.json`  — ClawLink Protocol identity endpoint
 *   - `/health`                           — basic health check
 *
 * The ClawLink Protocol (https://github.com/SilverstreamsAI/ClawNexus) allows
 * discovery tools to identify running AI framework instances on the network.
 * Responding to this well-known endpoint lets NanoClaw be auto-discovered by
 * any ClawLink-compatible scanner (e.g. ClawNexus).
 */
export function startHttpServer(port = 3100): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/.well-known/claw-identity.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(IDENTITY_RESPONSE);
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(HEALTH_RESPONSE);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  server.listen(port, () => {
    logger.info({ port }, `HTTP server listening on port ${port}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(
        { port },
        `Port ${port} already in use, HTTP server not started`,
      );
    } else {
      logger.error({ err }, 'HTTP server error');
    }
  });

  return server;
}
