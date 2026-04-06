import http from 'http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

import {
  startWebhookServer,
  stopWebhookServer,
  WebhookDeps,
} from './webhook.js';

function request(
  port: number,
  path: string,
  body: string,
  method = 'POST',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('webhook server', () => {
  let port: number;
  const onWebhookMessage = vi.fn();
  let mainJid: string | undefined = 'main-group-jid';

  const deps: WebhookDeps = {
    getMainGroupJid: () => mainJid,
    onWebhookMessage,
  };

  beforeAll(async () => {
    // Find a free port by briefly listening on port 0
    const srv = http.createServer();
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    port = (srv.address() as { port: number }).port;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    await new Promise((r) => setTimeout(r, 50));

    await startWebhookServer(port, deps);
  });

  afterAll(async () => {
    await stopWebhookServer();
  });

  it('returns 200 for valid POST /hooks/wake', async () => {
    onWebhookMessage.mockClear();
    const res = await request(port, '/hooks/wake', '{"text":"hello"}');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(onWebhookMessage).toHaveBeenCalledWith('main-group-jid', 'hello');
  });

  it('returns 404 for unknown path', async () => {
    const res = await request(port, '/other', '{"text":"hello"}');
    expect(res.status).toBe(404);
  });

  it('returns 405 for GET', async () => {
    const res = await request(port, '/hooks/wake', '', 'GET');
    expect(res.status).toBe(405);
  });

  it('returns 400 for invalid JSON', async () => {
    const res = await request(port, '/hooks/wake', 'not json');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Invalid JSON');
  });

  it('returns 400 for missing text field', async () => {
    const res = await request(port, '/hooks/wake', '{"foo":"bar"}');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('text');
  });

  it('returns 400 for empty text', async () => {
    const res = await request(port, '/hooks/wake', '{"text":"  "}');
    expect(res.status).toBe(400);
  });

  it('returns 503 when no main group is configured', async () => {
    mainJid = undefined;
    const res = await request(port, '/hooks/wake', '{"text":"hello"}');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toContain('main group');
    mainJid = 'main-group-jid';
  });
});
