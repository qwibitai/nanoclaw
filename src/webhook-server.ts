/**
 * HTTP server for Chat SDK adapter webhooks and the dashboard.
 *
 * Starts lazily on first adapter registration or explicit ensureServerStarted()
 * call. All routing goes through src/dashboard/router.ts dispatch so webhook
 * and dashboard routes share one table on one server.
 */
import http from 'http';

import type { Chat } from 'chat';

import { log } from './log.js';
import { register, dispatch } from './dashboard/router.js';

const DEFAULT_PORT = 3000;

interface WebhookEntry {
  chat: Chat;
  adapterName: string;
}

const webhookRoutes = new Map<string, WebhookEntry>();
let server: http.Server | null = null;

/** Convert Node.js IncomingMessage to a Web API Request. */
// 8 MiB body cap. Webhook adapters (Slack, Discord) send small JSON envelopes; the
// dashboard `/auth/exchange` body is tiny ({token: string}). Cap exists to prevent
// OOM/DoS via a single multi-GB POST to any endpoint, including unauthenticated
// /dashboard/api/auth/exchange (post-build QA fix SF-5).
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

class RequestTooLargeError extends Error {
  readonly statusCode = 413;
}

async function toWebRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    totalBytes += buf.length;
    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      throw new RequestTooLargeError(`request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  const body = Buffer.concat(chunks);

  const host = req.headers.host || 'localhost';
  const url = `http://${host}${req.url}`;

  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (typeof val === 'string') headers[key] = val;
    else if (Array.isArray(val)) headers[key] = val.join(', ');
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method || 'GET',
    headers,
    body: hasBody ? body : undefined,
  });
}

/** Write a Web API Response back to a Node.js ServerResponse. */
async function fromWebResponse(webRes: Response, nodeRes: http.ServerResponse): Promise<void> {
  nodeRes.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));
  if (webRes.body) {
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        nodeRes.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  nodeRes.end();
}

/**
 * Register a webhook adapter on the shared server.
 * Starts the server lazily on first call.
 */
export function registerWebhookAdapter(chat: Chat, adapterName: string, routingPath?: string): void {
  const key = routingPath ?? adapterName;
  webhookRoutes.set(key, { chat, adapterName });

  // Register the webhook path in the shared route table
  register('POST', `/webhook/${key}`, async (webReq) => {
    const entry = webhookRoutes.get(key);
    if (!entry) {
      return new Response(`Unknown adapter: ${key}`, { status: 404 });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webhooks = entry.chat.webhooks as Record<string, (r: Request, opts?: any) => Promise<Response>>;
    const handler = webhooks[entry.adapterName];
    return handler(webReq, {
      waitUntil: (p: Promise<unknown>) => {
        p.catch(() => {});
      },
    });
  });

  ensureServerStarted();
  log.info('Webhook adapter registered', { adapter: adapterName, path: `/webhook/${key}` });
}

/**
 * Start the HTTP server if not already started. Idempotent.
 * Called by registerWebhookAdapter and by the dashboard bootstrap so the
 * server is up regardless of whether any webhook adapters are registered.
 */
export function ensureServerStarted(): void {
  if (server) return;

  const port = parseInt(process.env.WEBHOOK_PORT || String(DEFAULT_PORT), 10);

  server = http.createServer(async (req, res) => {
    try {
      const webReq = await toWebRequest(req);
      const result = await dispatch(webReq, req, res);
      if (result !== null) {
        await fromWebResponse(result, res);
      }
      // null → handler already wrote to res directly (SSE bypass)
    } catch (err) {
      // Body cap (post-build QA fix SF-5) — return 413 instead of 500.
      if (err instanceof RequestTooLargeError) {
        log.warn('Request body too large — rejected', { url: req.url, max: MAX_REQUEST_BODY_BYTES });
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Payload Too Large');
        } else {
          res.end();
        }
        return;
      }
      log.error('Request handler error', { url: req.url, err });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log.info('Webhook server started', { port });
  });
}

/** Shut down the webhook server. */
export async function stopWebhookServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    webhookRoutes.clear();
    log.info('Webhook server stopped');
  }
}
