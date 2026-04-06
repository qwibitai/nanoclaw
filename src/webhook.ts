import http from 'http';

import { logger } from './logger.js';

const MAX_BODY_SIZE = 1_048_576; // 1MB

export interface WebhookDeps {
  getMainGroupJid: () => string | undefined;
  onWebhookMessage: (chatJid: string, text: string) => void;
}

let server: http.Server | null = null;

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startWebhookServer(
  port: number,
  deps: WebhookDeps,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if (req.url !== '/hooks/wake') {
        jsonResponse(res, 404, { error: 'Not found' });
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, {
          'Content-Type': 'application/json',
          Allow: 'POST',
        });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      let body = '';
      let aborted = false;

      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > MAX_BODY_SIZE) {
          aborted = true;
          jsonResponse(res, 413, { error: 'Request body too large' });
          req.destroy();
        }
      });

      req.on('end', () => {
        if (aborted) return;

        let parsed: { text?: unknown };
        try {
          parsed = JSON.parse(body) as { text?: unknown };
        } catch {
          jsonResponse(res, 400, { error: 'Invalid JSON' });
          return;
        }

        if (typeof parsed.text !== 'string' || parsed.text.trim() === '') {
          jsonResponse(res, 400, {
            error: 'Missing or empty "text" field',
          });
          return;
        }

        const mainJid = deps.getMainGroupJid();
        if (!mainJid) {
          jsonResponse(res, 503, { error: 'No main group configured' });
          return;
        }

        deps.onWebhookMessage(mainJid, parsed.text);
        jsonResponse(res, 200, { ok: true });
      });
    });

    srv.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn(
          { port },
          'Webhook port already in use — continuing without webhook',
        );
        resolve();
      } else {
        reject(err);
      }
    });

    srv.listen(port, '127.0.0.1', () => {
      logger.info({ port }, 'Webhook server listening');
      server = srv;
      resolve();
    });
  });
}

export function stopWebhookServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      server = null;
      resolve();
    });
  });
}
