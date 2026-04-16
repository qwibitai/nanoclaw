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

function makeRequestUntilDone(
  port: number,
  options: http.RequestOptions,
  body = '',
): Promise<{
  statusCode: number;
  body: string;
  terminalEvent: 'end' | 'close' | 'aborted';
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...options, hostname: '127.0.0.1', port },
      (res) => {
        const chunks: Buffer[] = [];
        let settled = false;
        const finish = (terminalEvent: 'end' | 'close' | 'aborted') => {
          if (settled) return;
          settled = true;
          resolve({
            statusCode: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            terminalEvent,
          });
        };

        res.on('data', (c) => chunks.push(c));
        res.on('end', () => finish('end'));
        res.on('close', () => finish('close'));
        res.on('aborted', () => finish('aborted'));
      },
    );

    req.setTimeout(2_000, () => {
      req.destroy(new Error('request timeout'));
    });
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
  let upstreamHandler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => void;

  beforeEach(async () => {
    lastUpstreamHeaders = {};
    upstreamHandler = (req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };

    upstreamServer = http.createServer((req, res) => {
      upstreamHandler(req, res);
    });
    await new Promise<void>((resolve) =>
      upstreamServer!.listen(0, '127.0.0.1', resolve),
    );
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
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxy(env: Record<string, string>): Promise<number> {
    const mergedEnv = { ...env };
    if (mergedEnv.ANTHROPIC_API_KEY && !mergedEnv.ANTHROPIC_BASE_URL) {
      mergedEnv.ANTHROPIC_BASE_URL = `http://127.0.0.1:${upstreamPort}`;
    }
    if (mergedEnv.OPENAI_API_KEY && !mergedEnv.OPENAI_BASE_URL) {
      mergedEnv.OPENAI_BASE_URL = `http://127.0.0.1:${upstreamPort}`;
    }

    Object.assign(mockEnv, mergedEnv);
    proxyServer = await startCredentialProxy(0);
    return (proxyServer!.address() as AddressInfo).port;
  }

  it('anthropic mode injects x-api-key and strips placeholder', async () => {
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

  it('openai mode replaces Authorization with Bearer real key', async () => {
    proxyPort = await startProxy({ OPENAI_API_KEY: 'sk-openai-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/chat/completions',
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

  it('openai mode replaces x-api-key when present', async () => {
    proxyPort = await startProxy({ OPENAI_API_KEY: 'sk-openai-real-key' });

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-openai-real-key');
    expect(lastUpstreamHeaders['authorization']).toBe(
      'Bearer sk-openai-real-key',
    );
  });

  it('returns 503 in disabled mode for direct-injection providers', async () => {
    proxyPort = await startProxy({ GEMINI_API_KEY: 'gem-real-key' });

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
    expect(res.body).toContain('disabled');
  });

  it('returns 503 in disabled mode for codex oauth provider', async () => {
    proxyPort = await startProxy({
      OAS_CODEX_OAUTH_JSON: '{"access":"a","refresh":"r","expires":1}',
    });

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
    expect(res.body).toContain('disabled');
  });

  it('throws when no supported provider key is configured', () => {
    expect(() => startCredentialProxy(0)).toThrow(
      'No supported provider credentials',
    );
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
      OPENAI_API_KEY: 'sk-openai-real-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:59999',
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer!.address() as AddressInfo).port;

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

  it('handles upstream error after headers are sent without hanging downstream', async () => {
    proxyPort = await startProxy({ OPENAI_API_KEY: 'sk-openai-real-key' });

    upstreamHandler = (req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial');
      setImmediate(() => {
        res.socket?.destroy(new Error('upstream disconnected after headers'));
      });
    };

    const brokenResponse = await makeRequestUntilDone(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(brokenResponse.statusCode).toBe(200);
    expect(['aborted', 'close', 'end']).toContain(brokenResponse.terminalEvent);
    expect(proxyServer?.listening).toBe(true);

    upstreamHandler = (req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };

    const recoveryResponse = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(recoveryResponse.statusCode).toBe(200);
    expect(recoveryResponse.body).toContain('"ok":true');
  });
});
