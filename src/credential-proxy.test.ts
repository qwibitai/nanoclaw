import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockResolvedProviderConfig = vi.hoisted((): { value: any } => ({
  value: {
    providers: {},
    defaultProvider: 'default',
    fallbackProviders: [],
    allowDirectSecretInjection: false,
    source: 'env' as const,
  },
}));

vi.mock('./provider-config.js', () => ({
  resolveProviderConfig: vi.fn(() => mockResolvedProviderConfig.value),
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
  let proxyServer: http.Server | undefined;
  let upstreamServer: http.Server | undefined;
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
    await new Promise<void>((resolve) => upstreamServer!.listen(0, resolve));
    upstreamPort = (upstreamServer!.address() as AddressInfo).port;
  });

  afterEach(async () => {
    if (proxyServer) {
      await new Promise<void>((r) => proxyServer!.close(() => r()));
      proxyServer = undefined;
    }
    if (upstreamServer) {
      await new Promise<void>((r) => upstreamServer!.close(() => r()));
      upstreamServer = undefined;
    }
  });

  async function startProxy(
    providers: Record<string, unknown>,
  ): Promise<number> {
    mockResolvedProviderConfig.value = {
      providers,
      defaultProvider: Object.keys(providers)[0] || 'default',
      fallbackProviders: Object.keys(providers).slice(1),
      allowDirectSecretInjection: false,
      source: 'yaml',
    };
    proxyServer = await startCredentialProxy(0, '0.0.0.0');
    return (proxyServer!.address() as AddressInfo).port;
  }

  it('anthropic route injects x-api-key and strips placeholder', async () => {
    proxyPort = await startProxy({
      claude: {
        name: 'claude',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        usesCredentialProxy: true,
        allowDirectSecretInjection: false,
        apiKey: 'sk-ant-real-key',
        upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`,
      },
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/__provider/claude/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('openai route replaces Authorization with Bearer real key', async () => {
    proxyPort = await startProxy({
      fast: {
        name: 'fast',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        usesCredentialProxy: true,
        allowDirectSecretInjection: false,
        apiKey: 'sk-openai-real-key',
        upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`,
      },
    });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/__provider/fast/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer sk-openai-real-key',
    );
  });

  it('returns 503 in disabled mode when only direct-injection providers exist', async () => {
    proxyPort = await startProxy({
      gemini: {
        name: 'gemini',
        provider: 'google',
        model: 'gemini-2.5-flash',
        usesCredentialProxy: false,
        allowDirectSecretInjection: true,
        apiKey: 'gem-key',
      },
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/__provider/gemini/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('disabled');
  });

  it('returns 404 for unknown provider routes', async () => {
    proxyPort = await startProxy({
      claude: {
        name: 'claude',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        usesCredentialProxy: true,
        allowDirectSecretInjection: false,
        apiKey: 'sk-ant-real-key',
        upstreamBaseURL: `http://127.0.0.1:${upstreamPort}`,
      },
    });

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/__provider/unknown/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Unknown provider route');
  });
});
