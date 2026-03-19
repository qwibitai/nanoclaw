import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const result: Record<string, string> = {};
    for (const key of keys) {
      if (mockEnv[key]) result[key] = mockEnv[key];
    }
    return result;
  }),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  startCredentialProxy,
  getFreshOAuthToken,
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

    // getFreshOAuthToken() reads from .env since no credentials file exists
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

  it('OAuth mode picks up updated token between requests', async () => {
    // Start with one token
    proxyPort = await startProxy({
      CLAUDE_CODE_OAUTH_TOKEN: 'token-v1',
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
    expect(lastUpstreamHeaders['authorization']).toBe('Bearer token-v1');

    // Simulate token refresh: update .env value
    mockEnv['CLAUDE_CODE_OAUTH_TOKEN'] = 'token-v2';

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
    // The proxy should have picked up the new token
    expect(lastUpstreamHeaders['authorization']).toBe('Bearer token-v2');
  });
});

describe('getFreshOAuthToken', () => {
  const credDir = path.join(os.homedir(), '.claude');
  const credFile = path.join(credDir, '.credentials.json');
  let originalCredContent: string | null = null;

  beforeEach(() => {
    // Save original file if it exists
    try {
      originalCredContent = fs.readFileSync(credFile, 'utf-8');
    } catch {
      originalCredContent = null;
    }
    // Clear mock env
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  afterEach(() => {
    // Restore original file
    if (originalCredContent !== null) {
      fs.writeFileSync(credFile, originalCredContent);
    } else {
      try {
        fs.unlinkSync(credFile);
      } catch {
        // File didn't exist, nothing to clean up
      }
    }
  });

  it('reads token from ~/.claude/.credentials.json when valid', () => {
    fs.mkdirSync(credDir, { recursive: true });
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    fs.writeFileSync(
      credFile,
      JSON.stringify({
        accessToken: 'cred-file-token',
        refreshToken: 'refresh-xxx',
        expiresAt: futureDate,
      }),
    );

    const token = getFreshOAuthToken();
    expect(token).toBe('cred-file-token');
  });

  it('falls back to .env when credentials file token is expired', () => {
    fs.mkdirSync(credDir, { recursive: true });
    const pastDate = new Date(Date.now() - 3600_000).toISOString();
    fs.writeFileSync(
      credFile,
      JSON.stringify({
        accessToken: 'expired-token',
        refreshToken: 'refresh-xxx',
        expiresAt: pastDate,
      }),
    );
    mockEnv['CLAUDE_CODE_OAUTH_TOKEN'] = 'env-fallback-token';

    const token = getFreshOAuthToken();
    expect(token).toBe('env-fallback-token');
  });

  it('uses token optimistically when expiresAt is absent', () => {
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(
      credFile,
      JSON.stringify({
        accessToken: 'no-expiry-token',
        refreshToken: 'refresh-xxx',
      }),
    );

    const token = getFreshOAuthToken();
    expect(token).toBe('no-expiry-token');
  });

  it('falls back to .env when credentials file does not exist', () => {
    // Ensure credentials file does not exist
    try {
      fs.unlinkSync(credFile);
    } catch {
      // Already absent
    }
    mockEnv['ANTHROPIC_AUTH_TOKEN'] = 'env-auth-token';

    const token = getFreshOAuthToken();
    expect(token).toBe('env-auth-token');
  });

  it('returns undefined when no token source is available', () => {
    try {
      fs.unlinkSync(credFile);
    } catch {
      // Already absent
    }
    // No mock env set

    const token = getFreshOAuthToken();
    expect(token).toBeUndefined();
  });
});
