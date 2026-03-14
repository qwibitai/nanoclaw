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

import { detectAuthMode, startCredentialProxy } from './credential-proxy.js';

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
  let lastUpstreamUrl: string;
  let lastUpstreamBody = '';

  beforeEach(async () => {
    lastUpstreamHeaders = {};

    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamUrl = req.url || '';
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        lastUpstreamBody = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
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

  it('preserves upstream base path prefix when forwarding', async () => {
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}/api`,
    });
    proxyServer = await startCredentialProxy(0);
    proxyPort = (proxyServer.address() as AddressInfo).port;

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages?x=1',
        headers: { 'content-type': 'application/json' },
      },
      '{}',
    );

    expect(lastUpstreamUrl).toBe('/api/v1/messages?x=1');
  });

  it('translates non-Anthropic OpenRouter models to chat completions', async () => {
    Object.assign(mockEnv, {
      OPENROUTER_API_KEY: 'sk-or-real-key',
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}/api`,
    });

    upstreamServer.close();
    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      lastUpstreamUrl = req.url || '';
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        lastUpstreamBody = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'gen_test',
            model: 'arcee-ai/trinity-large-preview:free',
            choices: [
              {
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'OK' },
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(upstreamPort, '127.0.0.1', resolve),
    );

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
      JSON.stringify({
        model: 'arcee-ai/trinity-large-preview:free',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    expect(lastUpstreamUrl).toBe('/api/v1/chat/completions');
    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-or-real-key');
    expect(JSON.parse(lastUpstreamBody)).toMatchObject({
      model: 'arcee-ai/trinity-large-preview:free',
      provider: { only: ['arcee-ai'], allow_fallbacks: false },
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(JSON.parse(res.body)).toMatchObject({
      type: 'message',
      model: 'arcee-ai/trinity-large-preview:free',
      content: [{ type: 'text', text: 'OK' }],
      usage: { input_tokens: 11, output_tokens: 2 },
      stop_reason: 'end_turn',
    });
  });

  it('synthesizes Anthropic streaming events for translated OpenRouter responses', async () => {
    Object.assign(mockEnv, {
      OPENROUTER_API_KEY: 'sk-or-real-key',
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}/api`,
    });

    upstreamServer.close();
    upstreamServer = http.createServer((req, res) => {
      lastUpstreamHeaders = { ...req.headers };
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        lastUpstreamBody = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'gen_tool',
            model: 'arcee-ai/trinity-large-preview:free',
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: 'Using tool',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'lookup',
                        arguments: '{"q":"abc"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 5 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(upstreamPort, '127.0.0.1', resolve),
    );

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
      JSON.stringify({
        model: 'arcee-ai/trinity-large-preview:free',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );

    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: message_start');
    expect(res.body).toContain('event: content_block_start');
    expect(res.body).toContain('text_delta');
    expect(res.body).toContain('input_json_delta');
    expect(res.body).toContain('tool_use');
    expect(res.body).toContain('event: message_stop');
    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-or-real-key');
  });

  it('keeps OAuth mode for non-OpenRouter upstream when only OPENROUTER_API_KEY exists', async () => {
    proxyPort = await startProxy({
      OPENROUTER_API_KEY: 'sk-or-real-key',
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

    expect(lastUpstreamHeaders['authorization']).toBe('Bearer real-oauth-token');
    expect(lastUpstreamHeaders['x-api-key']).toBeUndefined();
  });

  it('detectAuthMode uses OPENROUTER_API_KEY only for OpenRouter upstream', () => {
    Object.assign(mockEnv, {
      OPENROUTER_API_KEY: 'sk-or-real-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    expect(detectAuthMode()).toBe('oauth');

    Object.assign(mockEnv, {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    });
    expect(detectAuthMode()).toBe('api-key');
  });
});
