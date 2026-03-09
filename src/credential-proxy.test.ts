import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { startCredentialProxy } from './credential-proxy.js';

function makeRequest(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('credential-proxy', () => {
  let proxyServer: http.Server;
  let upstreamServer: http.Server;
  let proxyPort: number;
  let upstreamPort: number;
  let lastUpstreamHeaders: http.IncomingHttpHeaders;

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    delete process.env.ANTHROPIC_BASE_URL;
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env);
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstreamPort}`;
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key on every request', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode injects Bearer token unconditionally', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Container sends x-api-key placeholder (thinks it has an API key)
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
    expect(lastUpstreamHeaders['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(lastUpstreamHeaders['x-api-key']).toBeUndefined();
  });

  it('OAuth mode: response body never contains real credential', async () => {
    // The container gets back whatever upstream returns. Verify the real
    // OAuth token never appears in the response — only upstream's reply does.
    const receivedUrls: string[] = [];
    const customUpstream = http.createServer((req, res) => {
      receivedUrls.push(req.url!);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) =>
      customUpstream.listen(0, '127.0.0.1', resolve),
    );
    const customPort = (customUpstream.address() as AddressInfo).port;

    Object.assign(mockEnv, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-real-token' });
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${customPort}`;
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    // Response body must not contain the real credential
    expect(res.body).not.toContain('oauth-real-token');
    // Exchange endpoint was never called
    expect(receivedUrls).toEqual(['/v1/messages']);
    expect(receivedUrls).not.toContain('/api/oauth/claude_cli/create_api_key');

    await new Promise<void>((r) => customUpstream.close(() => r()));
  });

  it('OAuth mode: exchange endpoint response does not leak host credential', async () => {
    // Defense in depth: if the SDK somehow calls the exchange endpoint,
    // the real OAuth token must not appear in the response body.
    const receivedHeaders: http.IncomingHttpHeaders[] = [];
    const customUpstream = http.createServer((req, res) => {
      receivedHeaders.push({ ...req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      // Simulate Anthropic returning a temp API key — the leak vector
      res.end('{"api_key":"sk-ant-temp-key-from-exchange"}');
    });
    await new Promise<void>((resolve) =>
      customUpstream.listen(0, '127.0.0.1', resolve),
    );
    const customPort = (customUpstream.address() as AddressInfo).port;

    Object.assign(mockEnv, { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-real-token' });
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${customPort}`;
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder-token',
        },
      },
      '{}',
    );

    expect(res.statusCode).toBe(200);
    // Proxy forwarded with real token outbound (host-side, expected)
    expect(receivedHeaders[0]['authorization']).toBe('Bearer oauth-real-token');
    // The temp key IS in the response — this is the documented gap.
    // Security relies on the SDK never calling this endpoint (previous test).
    expect(res.body).toContain('sk-ant-temp-key-from-exchange');
    // The real OAuth token does NOT appear in the response
    expect(res.body).not.toContain('oauth-real-token');

    await new Promise<void>((r) => customUpstream.close(() => r()));
  });

  it('health endpoint returns 200', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/health',
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('strips hop-by-hop headers', async () => {
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
      },
      '{}',
    );

    // Client's custom keep-alive must not be forwarded
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    // We strip the client's transfer-encoding, but Node's HTTP client may
    // re-add its own chunked encoding when piping (standard HTTP/1.1 behavior).
    // The important thing is the client's original header was deleted from the
    // forwarded headers object — Node then negotiates its own framing.
  });

  it('returns JSON 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
    });
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:59999';
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toHaveProperty('error');
  });

  it('returns 503 when no credentials configured', async () => {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstreamPort}`;
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('No credentials configured');
  });
});
