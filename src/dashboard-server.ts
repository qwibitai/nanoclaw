import http, { type IncomingMessage, type ServerResponse } from 'http';

import { DASHBOARD_HTML } from './dashboard-ui.js';

interface DashboardConfig {
  port: number;
  secret: string;
}

let server: http.Server | null = null;
let latestSnapshot: Record<string, unknown> | null = null;
const dashboardLogs: string[] = [];

export function startDashboard(config: DashboardConfig): http.Server {
  stopDashboard();

  server = http.createServer((req, res) => {
    void handleRequest(req, res, config).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    });
  });

  server.listen(config.port, '127.0.0.1');
  return server;
}

export function stopDashboard(): void {
  if (!server) return;
  server.close();
  server = null;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, config: DashboardConfig): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/') {
    redirect(res, '/dashboard');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/dashboard') {
    sendHtml(res, DASHBOARD_HTML);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, {
      ok: true,
      snapshot: latestSnapshot,
      logs: dashboardLogs.slice(-500),
      serverTime: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, hasSnapshot: latestSnapshot !== null });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/ingest') {
    if (!isAuthorized(req, config.secret)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const body = await readJsonBodyOrFail(req, res);
    if (body === null) return;
    latestSnapshot = isRecord(body) ? body : { value: body };
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logs/push') {
    if (!isAuthorized(req, config.secret)) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const body = await readJsonBodyOrFail(req, res);
    if (body === null) return;
    if (isRecord(body) && Array.isArray(body.lines)) {
      for (const line of body.lines) {
        if (typeof line === 'string') dashboardLogs.push(line.slice(0, 5000));
      }
      while (dashboardLogs.length > 1500) dashboardLogs.shift();
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
}

function isAuthorized(req: IncomingMessage, secret: string): boolean {
  return req.headers.authorization === `Bearer ${secret}`;
}

async function readJsonBodyOrFail(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
  try {
    return await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : 'invalid JSON body' });
    return null;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  const limit = 25 * 1024 * 1024;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new Error('request body too large');
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders('html'),
  });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...securityHeaders('json'),
  });
  res.end(payload);
}

function securityHeaders(kind: 'html' | 'json'): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...(kind === 'html'
      ? {
          'Content-Security-Policy':
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
