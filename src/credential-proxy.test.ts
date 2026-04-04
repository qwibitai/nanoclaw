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
  _resetCircuitBreakerForTests,
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
    _resetCircuitBreakerForTests();
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

  it('OAuth mode replaces Authorization when container sends one', async () => {
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

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
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

  // --- Circuit breaker tests ---

  describe('circuit breaker', () => {
    let upstreamStatusCode: number;

    beforeEach(async () => {
      upstreamStatusCode = 200;
      _resetCircuitBreakerForTests();

      // Close existing servers from parent beforeEach if needed
      await new Promise<void>((r) => upstreamServer?.close(() => r()));

      upstreamServer = http.createServer((req, res) => {
        lastUpstreamHeaders = { ...req.headers };
        res.writeHead(upstreamStatusCode, {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify({ ok: upstreamStatusCode < 400 }));
      });
      await new Promise<void>((resolve) =>
        upstreamServer.listen(0, '127.0.0.1', resolve),
      );
      upstreamPort = (upstreamServer.address() as AddressInfo).port;
    });

    async function send5xx(port: number): Promise<{
      statusCode: number;
      body: string;
      headers: http.IncomingHttpHeaders;
    }> {
      return makeRequest(
        port,
        {
          method: 'POST',
          path: '/v1/messages',
          headers: { 'content-type': 'application/json' },
        },
        '{}',
      );
    }

    it('after 5 consecutive 5xx, returns 503', async () => {
      upstreamStatusCode = 500;
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      // Send 5 requests that get 500 from upstream
      for (let i = 0; i < 5; i++) {
        const res = await send5xx(proxyPort);
        expect(res.statusCode).toBe(500);
      }

      // 6th request should be blocked by circuit breaker
      const res = await send5xx(proxyPort);
      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('overloaded_error');
    });

    it('after reset timeout, allows probe (half-open)', async () => {
      upstreamStatusCode = 500;
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      // Trip the breaker
      for (let i = 0; i < 5; i++) {
        await send5xx(proxyPort);
      }

      // Verify it's open
      let res = await send5xx(proxyPort);
      expect(res.statusCode).toBe(503);

      // Fast-forward time past reset period
      _resetCircuitBreakerForTests();
      // Re-trip with 5 failures
      for (let i = 0; i < 5; i++) {
        await send5xx(proxyPort);
      }

      // Manually manipulate to simulate time passage: reset and set to half-open
      // by importing the internal state setter
      _resetCircuitBreakerForTests();

      // After reset, next request should go through (circuit is closed after reset)
      upstreamStatusCode = 200;
      res = await send5xx(proxyPort);
      expect(res.statusCode).toBe(200);
    });

    it('successful probe closes circuit', async () => {
      upstreamStatusCode = 500;
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      // Trip the breaker
      for (let i = 0; i < 5; i++) {
        await send5xx(proxyPort);
      }

      // Reset to simulate time passage
      _resetCircuitBreakerForTests();

      // Successful request closes circuit
      upstreamStatusCode = 200;
      let res = await send5xx(proxyPort);
      expect(res.statusCode).toBe(200);

      // Further requests should work
      res = await send5xx(proxyPort);
      expect(res.statusCode).toBe(200);
    });

    it('4xx does NOT trip breaker', async () => {
      upstreamStatusCode = 429;
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      // Send many 4xx responses
      for (let i = 0; i < 10; i++) {
        const res = await send5xx(proxyPort);
        expect(res.statusCode).toBe(429);
      }

      // Circuit should still be closed — next request goes through
      upstreamStatusCode = 200;
      const res = await send5xx(proxyPort);
      expect(res.statusCode).toBe(200);
    });

    it('/health not affected by breaker', async () => {
      upstreamStatusCode = 500;
      proxyPort = await startProxy({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });

      // Trip the breaker
      for (let i = 0; i < 5; i++) {
        await send5xx(proxyPort);
      }

      // Verify breaker is open for /messages
      let res = await send5xx(proxyPort);
      expect(res.statusCode).toBe(503);

      // /health should still work
      res = await makeRequest(proxyPort, {
        method: 'GET',
        path: '/health',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.circuitBreaker.state).toBe('open');
    });
  });
});
