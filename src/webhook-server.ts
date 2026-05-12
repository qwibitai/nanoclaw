/**
 * Minimal HTTP server for Chat SDK adapter webhooks and push-inbound channels.
 *
 * Starts lazily on first adapter registration. Routes requests by path:
 *   /webhook/{adapterName}          → Chat SDK adapter handler
 *   /v1/inbound/webhook/:mgId       → push-inbound webhook channel handler
 *
 * Multiple Chat instances can register adapters — each adapter name maps
 * to its owning Chat instance.
 */
import http from 'http';

import type { Chat } from 'chat';

import { log } from './log.js';

const DEFAULT_PORT = 3000;

interface WebhookEntry {
  chat: Chat;
  adapterName: string;
}

/** Handler registered by the webhook channel adapter for POST /v1/inbound/webhook/:mgId */
export type WebhookInboundHandler = (
  mgId: string,
  rawBody: Buffer,
  headers: Record<string, string>,
) => Promise<{ status: number; body: string; contentType?: string }>;

const routes = new Map<string, WebhookEntry>();
let webhookInboundHandler: WebhookInboundHandler | null = null;
let server: http.Server | null = null;

/** Convert Node.js IncomingMessage to a Web API Request. */
async function toWebRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
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
export function registerWebhookAdapter(chat: Chat, adapterName: string): void {
  routes.set(adapterName, { chat, adapterName });
  ensureServer();
  log.info('Webhook adapter registered', { adapter: adapterName, path: `/webhook/${adapterName}` });
}

/**
 * Register the push-inbound handler for /v1/inbound/webhook/:mgId.
 * Called by the webhook channel adapter on setup.
 */
export function registerWebhookInboundRoute(handler: WebhookInboundHandler): void {
  webhookInboundHandler = handler;
  ensureServer();
  log.info('Webhook inbound route registered', { path: '/v1/inbound/webhook/:mgId' });
}

function ensureServer(): void {
  if (server) return;

  const port = parseInt(process.env.WEBHOOK_PORT || String(DEFAULT_PORT), 10);

  server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    // Route: /v1/inbound/webhook/:mgId
    const inboundMatch = url.match(/^\/v1\/inbound\/webhook\/([^/?]+)/);
    if (inboundMatch) {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method Not Allowed');
        return;
      }
      if (!webhookInboundHandler) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Webhook inbound handler not registered');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks);

      const headers: Record<string, string> = {};
      for (const [key, val] of Object.entries(req.headers)) {
        if (typeof val === 'string') headers[key.toLowerCase()] = val;
        else if (Array.isArray(val)) headers[key.toLowerCase()] = val.join(', ');
      }

      const mgId = inboundMatch[1]!;
      try {
        const result = await webhookInboundHandler(mgId, rawBody, headers);
        res.writeHead(result.status, { 'Content-Type': result.contentType ?? 'text/plain' });
        res.end(result.body);
      } catch (err) {
        log.error('Webhook inbound handler error', { mgId, err });
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      }
      return;
    }

    // Route: /webhook/{adapterName}
    const match = url.match(/^\/webhook\/([^/?]+)/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const adapterName = match[1];
    const entry = routes.get(adapterName);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Unknown adapter: ${adapterName}`);
      return;
    }

    try {
      const webReq = await toWebRequest(req);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const webhooks = entry.chat.webhooks as Record<string, (r: Request, opts?: any) => Promise<Response>>;
      const handler = webhooks[entry.adapterName];
      const webRes = await handler(webReq, {
        waitUntil: (p: Promise<unknown>) => {
          p.catch(() => {});
        },
      });
      await fromWebResponse(webRes, res);
    } catch (err) {
      log.error('Webhook handler error', { adapter: adapterName, url: req.url, err });
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log.info('Webhook server started', { port, adapters: [...routes.keys()] });
  });
}

/** Shut down the webhook server. */
export async function stopWebhookServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    routes.clear();
    webhookInboundHandler = null;
    log.info('Webhook server stopped');
  }
}
