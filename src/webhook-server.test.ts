/**
 * Tests for the refactored webhook-server:
 * - ensureServerStarted() is idempotent
 * - existing /webhook/:adapter routes still work
 * - dashboard routes dispatch via the shared router
 * - SSE-style handlers returning null bypass fromWebResponse
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Reset module state between tests
beforeEach(() => {
  vi.resetModules();
});

afterEach(async () => {
  // Best-effort stop — module may have been reset so server ref is gone
  try {
    const mod = await import('./webhook-server.js');
    await mod.stopWebhookServer();
  } catch {
    // already stopped or module reset
  }
});

async function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function httpPost(
  port: number,
  path: string,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

describe('webhook-server', () => {
  it('test_ensureServerStarted_idempotent', async () => {
    const port = await getFreePort();
    process.env.WEBHOOK_PORT = String(port);

    const { ensureServerStarted, stopWebhookServer } = await import('./webhook-server.js');

    ensureServerStarted();
    ensureServerStarted(); // second call must be no-op

    // Server should be up and answering
    const result = await httpGet(port, '/health-check-does-not-exist');
    // 404 from router means one server instance is running
    expect(result.status).toBe(404);

    await stopWebhookServer();
    delete process.env.WEBHOOK_PORT;
  });

  it('test_webhook_route_still_works', async () => {
    const port = await getFreePort();
    process.env.WEBHOOK_PORT = String(port);

    const { registerWebhookAdapter, ensureServerStarted, stopWebhookServer } = await import('./webhook-server.js');

    const mockHandlerFn = vi.fn().mockResolvedValue(new Response('webhook-ok', { status: 200 }));
    const mockChat = {
      webhooks: {
        'mock-adapter': mockHandlerFn,
      },
    };

    // registerWebhookAdapter also calls ensureServerStarted internally
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerWebhookAdapter(mockChat as any, 'mock-adapter');
    ensureServerStarted();

    const result = await httpPost(port, '/webhook/mock-adapter', '{}');
    expect(result.status).toBe(200);
    expect(mockHandlerFn).toHaveBeenCalledOnce();

    await stopWebhookServer();
    delete process.env.WEBHOOK_PORT;
  });

  it('test_dashboard_route_via_dispatch', async () => {
    const port = await getFreePort();
    process.env.WEBHOOK_PORT = String(port);

    // Register a test route via the shared router before starting the server
    const routerMod = await import('./dashboard/router.js');
    routerMod.register('GET', '/test-route', async () => new Response('ok', { status: 200 }));

    const { ensureServerStarted, stopWebhookServer } = await import('./webhook-server.js');
    ensureServerStarted();

    const result = await httpGet(port, '/test-route');
    expect(result.status).toBe(200);
    expect(result.body).toBe('ok');

    await stopWebhookServer();
    delete process.env.WEBHOOK_PORT;
  });

  it('test_sse_null_return_no_fromWebResponse_call', async () => {
    const port = await getFreePort();
    process.env.WEBHOOK_PORT = String(port);

    const routerMod = await import('./dashboard/router.js');
    let rawWriteCalled = false;

    routerMod.register('GET', '/test-sse', async (_req, _params, ctx) => {
      if (ctx.rawNodeRes) {
        ctx.rawNodeRes.writeHead(200, { 'Content-Type': 'text/event-stream' });
        ctx.rawNodeRes.write(':keepalive\n\n');
        ctx.rawNodeRes.end();
        rawWriteCalled = true;
      }
      return null;
    });

    const { ensureServerStarted, stopWebhookServer } = await import('./webhook-server.js');
    ensureServerStarted();

    const result = await httpGet(port, '/test-sse');
    // The handler wrote directly; response arrives
    expect(result.status).toBe(200);
    expect(rawWriteCalled).toBe(true);

    await stopWebhookServer();
    delete process.env.WEBHOOK_PORT;
  });
});
