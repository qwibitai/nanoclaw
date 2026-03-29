import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
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
  readCredentials,
  refreshOAuthToken,
  ensureValidToken,
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
});

describe('readCredentials', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads accessToken, refreshToken, expiresAt from credentials file', () => {
    const credPath = path.join(tmpDir, '.credentials.json');
    fs.writeFileSync(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'at-123',
          refreshToken: 'rt-456',
          expiresAt: 1700000000000,
        },
      }),
    );

    const creds = readCredentials(credPath);
    expect(creds.accessToken).toBe('at-123');
    expect(creds.refreshToken).toBe('rt-456');
    expect(creds.expiresAt).toBe(1700000000000);
  });

  it('throws if file does not exist', () => {
    expect(() =>
      readCredentials(path.join(tmpDir, 'nonexistent.json')),
    ).toThrow();
  });

  it('throws if claudeAiOauth is missing', () => {
    const credPath = path.join(tmpDir, '.credentials.json');
    fs.writeFileSync(credPath, JSON.stringify({ someOtherKey: {} }));

    expect(() => readCredentials(credPath)).toThrow(/claudeAiOauth/);
  });
});

describe('refreshOAuthToken', () => {
  let tokenServer: http.Server;
  let tokenPort: number;

  beforeEach(async () => {
    tokenServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString());
        const refreshToken = body.get('refresh_token');

        if (refreshToken === 'valid-refresh') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'new-access-token',
              refresh_token: 'new-refresh-token',
              expires_in: 3600,
            }),
          );
        } else {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
        }
      });
    });
    await new Promise<void>((resolve) =>
      tokenServer.listen(0, '127.0.0.1', resolve),
    );
    tokenPort = (tokenServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => tokenServer?.close(() => r()));
  });

  it('returns new tokens on successful refresh', async () => {
    const result = await refreshOAuthToken(
      'valid-refresh',
      `http://127.0.0.1:${tokenPort}/v1/oauth/token`,
    );

    expect(result.accessToken).toBe('new-access-token');
    expect(result.refreshToken).toBe('new-refresh-token');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('throws on 401 response', async () => {
    await expect(
      refreshOAuthToken(
        'invalid-refresh',
        `http://127.0.0.1:${tokenPort}/v1/oauth/token`,
      ),
    ).rejects.toThrow(/401/);
  });

  it('throws on network error', async () => {
    await expect(
      refreshOAuthToken('some-token', 'http://127.0.0.1:59999/v1/oauth/token'),
    ).rejects.toThrow();
  });
});

describe('ensureValidToken', () => {
  let tmpDir: string;
  let refreshServer: http.Server;
  let refreshPort: number;
  let refreshCallCount: number;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-token-test-'));
    refreshCallCount = 0;

    refreshServer = http.createServer((req, res) => {
      refreshCallCount++;
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'refreshed-access-token',
            refresh_token: 'refreshed-refresh-token',
            expires_in: 7200,
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      refreshServer.listen(0, '127.0.0.1', resolve),
    );
    refreshPort = (refreshServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => refreshServer?.close(() => r()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refreshes token when within 5 minutes of expiry', async () => {
    const credsPath = path.join(tmpDir, '.credentials.json');
    fs.writeFileSync(
      credsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'old-access',
          refreshToken: 'valid-refresh',
          expiresAt: Date.now() + 2 * 60 * 1000, // 2 min from now
          scopes: ['read', 'write'],
          subscriptionType: 'pro',
        },
      }),
    );

    const result = await ensureValidToken(
      credsPath,
      `http://127.0.0.1:${refreshPort}/v1/oauth/token`,
    );

    expect(result.accessToken).toBe('refreshed-access-token');
    expect(result.refreshToken).toBe('refreshed-refresh-token');
    expect(result.expiresAt).toBeGreaterThan(Date.now());

    // Verify file was written back with new tokens and original fields preserved
    const written = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    expect(written.claudeAiOauth.accessToken).toBe('refreshed-access-token');
    expect(written.claudeAiOauth.refreshToken).toBe('refreshed-refresh-token');
    expect(written.claudeAiOauth.scopes).toEqual(['read', 'write']);
    expect(written.claudeAiOauth.subscriptionType).toBe('pro');
  });

  it('does not refresh when token is still valid', async () => {
    const credsPath = path.join(tmpDir, '.credentials.json');
    fs.writeFileSync(
      credsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'still-valid-access',
          refreshToken: 'some-refresh',
          expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
        },
      }),
    );

    const result = await ensureValidToken(
      credsPath,
      `http://127.0.0.1:${refreshPort}/v1/oauth/token`,
    );

    expect(result.accessToken).toBe('still-valid-access');
    expect(refreshCallCount).toBe(0);
  });
});
