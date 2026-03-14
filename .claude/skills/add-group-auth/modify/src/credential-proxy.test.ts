import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  startCredentialProxy,
  setCredentialResolver,
  registerContainerIP,
  unregisterContainerIP,
  registerProxyService,
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

describe('credential-proxy (per-group-auth)', () => {
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
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, '127.0.0.1', resolve),
    );
    upstreamPort = (upstreamServer.address() as AddressInfo).port;

    // Register a test service that forwards to our upstream
    registerProxyService({
      prefix: 'claude',
      forward(req, res, path, body, secrets) {
        const headers: Record<string, string | number | string[] | undefined> = {
          ...(req.headers as Record<string, string>),
          host: `127.0.0.1:${upstreamPort}`,
          'content-length': body.length,
        };
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (secrets.ANTHROPIC_API_KEY) {
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = http.request(
          {
            hostname: '127.0.0.1',
            port: upstreamPort,
            path,
            method: req.method,
            headers,
          },
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );
        upstream.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });
        upstream.write(body);
        upstream.end();
      },
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => proxyServer?.close(() => r()));
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
  });

  async function startProxy(
    resolver: (scope: string) => Record<string, string>,
  ): Promise<number> {
    setCredentialResolver(resolver);
    proxyServer = await startCredentialProxy(0, '127.0.0.1');
    return (proxyServer.address() as AddressInfo).port;
  }

  it('strips /claude/ prefix before forwarding upstream', async () => {
    proxyPort = await startProxy(() => ({ ANTHROPIC_API_KEY: 'sk-test' }));

    await makeRequest(proxyPort, {
      method: 'POST',
      path: '/claude/v1/messages',
      headers: { 'content-type': 'application/json' },
    }, '{}');

    expect(lastUpstreamPath).toBe('/v1/messages');
  });

  it('rejects requests without service prefix', async () => {
    proxyPort = await startProxy(() => ({}));

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/',
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for unknown service prefix', async () => {
    proxyPort = await startProxy(() => ({}));

    const res = await makeRequest(proxyPort, {
      method: 'GET',
      path: '/unknown/v1/test',
    });

    expect(res.statusCode).toBe(404);
  });

  it('resolves scope from container IP', async () => {
    const resolvedScopes: string[] = [];
    proxyPort = await startProxy((scope) => {
      resolvedScopes.push(scope);
      return { ANTHROPIC_API_KEY: `key-for-${scope}` };
    });

    // Requests from localhost (127.0.0.1) — no IP registered, falls back to 'default'
    await makeRequest(proxyPort, {
      method: 'POST',
      path: '/claude/v1/messages',
      headers: { 'content-type': 'application/json' },
    }, '{}');

    expect(resolvedScopes).toContain('default');
  });

  it('uses registered container IP for scope resolution', async () => {
    const resolvedScopes: string[] = [];
    // Register 127.0.0.1 as a known container
    registerContainerIP('127.0.0.1', 'my-group');

    proxyPort = await startProxy((scope) => {
      resolvedScopes.push(scope);
      return { ANTHROPIC_API_KEY: `key-for-${scope}` };
    });

    await makeRequest(proxyPort, {
      method: 'POST',
      path: '/claude/v1/messages',
      headers: { 'content-type': 'application/json' },
    }, '{}');

    expect(resolvedScopes).toContain('my-group');
    expect(lastUpstreamHeaders['x-api-key']).toBe('key-for-my-group');

    unregisterContainerIP('127.0.0.1');
  });

  it('injects API key from resolved credentials', async () => {
    proxyPort = await startProxy(() => ({ ANTHROPIC_API_KEY: 'sk-ant-real-key' }));

    await makeRequest(proxyPort, {
      method: 'POST',
      path: '/claude/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'placeholder',
      },
    }, '{}');

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('injects OAuth token on Authorization header', async () => {
    proxyPort = await startProxy(() => ({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    }));

    await makeRequest(proxyPort, {
      method: 'POST',
      path: '/claude/api/oauth/claude_cli/create_api_key',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer placeholder',
      },
    }, '{}');

    expect(lastUpstreamHeaders['authorization']).toBe('Bearer real-oauth-token');
  });
});
