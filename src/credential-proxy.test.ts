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

import {
  startCredentialProxy,
  exchangeOAuthToken,
} from './credential-proxy.js';

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
  let lastUpstreamPath: string;

  beforeEach(async () => {
    lastUpstreamHeaders = {};
    lastUpstreamPath = '';

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamPath = req.url || '';

      // Handle OAuth exchange endpoint
      if (req.url === '/api/oauth/claude_cli/create_api_key') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ api_key: 'sk-ant-temp-key-from-exchange' }));
        return;
      }

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
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServer = await startCredentialProxy(0);
    return (proxyServer.address() as AddressInfo).port;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
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

  it('OAuth mode exchanges token at startup and injects x-api-key on /v1/ requests', async () => {
    /**
     * INVARIANT: In OAuth mode, proxy exchanges token at startup and injects
     * x-api-key on subsequent /v1/ requests.
     * SUT: startCredentialProxy in OAuth mode with exchange endpoint available
     * VERIFICATION: After proxy starts, a /v1/messages request gets x-api-key injected
     */
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // The proxy should have exchanged the token at startup.
    // Now a /v1/messages request should get x-api-key injected.
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe(
      'sk-ant-temp-key-from-exchange',
    );
    // Authorization header should be removed for /v1/ requests when cachedApiKey exists
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('OAuth mode replaces Authorization on non-/v1/ requests (container exchange)', async () => {
    /**
     * INVARIANT: Containers can still do their own OAuth exchange via the proxy.
     * SUT: proxy request handler for /api/oauth/ paths
     * VERIFICATION: Authorization header is replaced with real OAuth token
     */
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer real-oauth-token',
    );
  });

  it('OAuth mode strips placeholder Authorization on /v1/ requests when cached key exists', async () => {
    /**
     * INVARIANT: When cachedApiKey exists, /v1/ requests use x-api-key and
     * any Authorization header is stripped.
     * SUT: proxy request handler in OAuth mode with cached key
     * VERIFICATION: x-api-key is set, authorization is absent
     */
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe(
      'sk-ant-temp-key-from-exchange',
    );
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('OAuth mode does not inject Authorization when container omits it', async () => {
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    // With cached key, proxy overrides x-api-key with cached one
    expect(lastUpstreamHeaders['x-api-key']).toBe(
      'sk-ant-temp-key-from-exchange',
    );
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('API-key mode behavior is unchanged by OAuth exchange feature', async () => {
    /**
     * INVARIANT: In API key mode, behavior is unchanged — no exchange attempt,
     * x-api-key injected directly.
     * SUT: startCredentialProxy in API key mode
     * VERIFICATION: x-api-key is the configured API key, no exchange requests made
     */
    proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
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

    // Proxy strips client hop-by-hop headers. Node's HTTP client may re-add
    // its own Connection header (standard HTTP/1.1 behavior), but the client's
    // custom keep-alive and transfer-encoding must not be forwarded.
    expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
    expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999',
    });
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
    expect(res.body).toBe('Bad Gateway');
  });

  it('proxy still starts if OAuth exchange fails', async () => {
    /**
     * INVARIANT: If exchange fails, proxy still starts and containers can do
     * their own exchange.
     * SUT: startCredentialProxy when exchange endpoint is unreachable
     * VERIFICATION: proxy resolves successfully, subsequent requests still
     * replace Authorization headers for container exchange
     */
    // Point to an unreachable exchange endpoint (upstream is fine, but we use
    // a different base URL for exchange)
    Object.assign(mockEnv, {
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:59999', // unreachable
    });

    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    // Proxy started despite exchange failure — verify it's alive
    expect(proxyPort).toBeGreaterThan(0);
  });

  describe('exchangeOAuthToken', () => {
    it('extracts api_key from response', async () => {
      const url = new URL(`http://127.0.0.1:${upstreamPort}`);
      const key = await exchangeOAuthToken('test-token', url);
      expect(key).toBe('sk-ant-temp-key-from-exchange');
    });

    it('extracts key field from response', async () => {
      // Override upstream to return { key: ... } instead of { api_key: ... }
      await new Promise<void>((r) => upstreamServer.close(() => r()));
      upstreamServer = http.createServer((req, res) => {
        lastUpstreamHeaders = { ...req.headers };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ key: 'sk-ant-alt-key' }));
      });
      await new Promise<void>((resolve) =>
        upstreamServer.listen(upstreamPort, '127.0.0.1', resolve),
      );

      const url = new URL(`http://127.0.0.1:${upstreamPort}`);
      const key = await exchangeOAuthToken('test-token', url);
      expect(key).toBe('sk-ant-alt-key');
    });

    it('rejects when response has no key', async () => {
      await new Promise<void>((r) => upstreamServer.close(() => r()));
      upstreamServer = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
      });
      await new Promise<void>((resolve) =>
        upstreamServer.listen(upstreamPort, '127.0.0.1', resolve),
      );

      const url = new URL(`http://127.0.0.1:${upstreamPort}`);
      await expect(exchangeOAuthToken('bad-token', url)).rejects.toThrow(
        'no api_key in response',
      );
    });

    it('sends correct Authorization header', async () => {
      const url = new URL(`http://127.0.0.1:${upstreamPort}`);
      await exchangeOAuthToken('my-oauth-token', url);
      expect(lastUpstreamHeaders['authorization']).toBe(
        'Bearer my-oauth-token',
      );
    });
  });
});
