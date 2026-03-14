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

import { startCredentialProxies, type CredentialProxyServers } from './credential-proxy.js';

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

describe('credential-proxy (port-based routing)', () => {
  let proxyServers: CredentialProxyServers;
  let upstreamServer: http.Server;
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
    proxyServers?.close();
    await new Promise<void>((r) => upstreamServer?.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  async function startProxies(env: Record<string, string>): Promise<CredentialProxyServers> {
    Object.assign(mockEnv, env, {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      GROQ_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
      OPENAI_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    });
    proxyServers = await startCredentialProxies({
      anthropic: 0, // Use 0 to get random available ports
      groq: 0,
      openai: 0,
    });
    return proxyServers;
  }

  function getAnthropicPort(): number {
    return (proxyServers.anthropic?.address() as AddressInfo)?.port || 0;
  }

  function getGroqPort(): number {
    return (proxyServers.groq?.address() as AddressInfo)?.port || 0;
  }

  function getOpenaiPort(): number {
    return (proxyServers.openai?.address() as AddressInfo)?.port || 0;
  }

  it('API-key mode injects x-api-key and strips placeholder', async () => {
    await startProxies({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });
    const proxyPort = getAnthropicPort();

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'host': 'api.anthropic.com',
          'x-api-key': 'placeholder',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('sk-ant-real-key');
  });

  it('OAuth mode replaces Authorization when container sends one', async () => {
    await startProxies({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });
    const proxyPort = getAnthropicPort();

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/api/oauth/claude_cli/create_api_key',
        headers: {
          'content-type': 'application/json',
          'host': 'api.anthropic.com',
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
    await startProxies({
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });
    const proxyPort = getAnthropicPort();

    // Post-exchange: container uses x-api-key only, no Authorization header
    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'host': 'api.anthropic.com',
          'x-api-key': 'temp-key-from-exchange',
        },
      },
      '{}',
    );

    expect(lastUpstreamHeaders['x-api-key']).toBe('temp-key-from-exchange');
    expect(lastUpstreamHeaders['authorization']).toBeUndefined();
  });

  it('strips hop-by-hop headers', async () => {
    await startProxies({ ANTHROPIC_API_KEY: 'sk-ant-real-key' });
    const proxyPort = getAnthropicPort();

    await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'host': 'api.anthropic.com',
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
    proxyServers = await startCredentialProxies({
      anthropic: 0,
      groq: 0,
      openai: 0,
    });
    const proxyPort = getAnthropicPort();

    const res = await makeRequest(
      proxyPort,
      {
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json', 'host': 'api.anthropic.com' },
      },
      '{}',
    );

    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('Bad Gateway');
  });

  describe('Groq routing (dedicated port)', () => {
    beforeEach(async () => {
      mockEnv.GROQ_API_KEY = 'groq-real-api-key';
    });

    it('injects Authorization header with GROQ_API_KEY', async () => {
      await startProxies({ GROQ_API_KEY: 'groq-real-api-key' });
      const groqPort = getGroqPort();

      await makeRequest(
        groqPort,
        {
          method: 'POST',
          path: '/openai/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer placeholder',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['authorization']).toBe('Bearer groq-real-api-key');
    });

    it('rewrites Host header to upstream server', async () => {
      await startProxies({ GROQ_API_KEY: 'groq-real-api-key' });
      const groqPort = getGroqPort();

      await makeRequest(
        groqPort,
        {
          method: 'POST',
          path: '/openai/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['host']).toBe(`127.0.0.1:${upstreamPort}`);
    });

    it('routes Groq requests via dedicated port', async () => {
      await startProxies({ GROQ_API_KEY: 'groq-real-api-key' });
      const groqPort = getGroqPort();

      await makeRequest(
        groqPort,
        {
          method: 'POST',
          path: '/openai/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
          },
        },
        '{"model": "llama3-8b-8192", "messages": [{"role": "user", "content": "Hello"}]}',
      );

      expect(lastUpstreamHeaders['authorization']).toBe('Bearer groq-real-api-key');
    });

    it('strips hop-by-hop headers for Groq requests', async () => {
      await startProxies({ GROQ_API_KEY: 'groq-real-api-key' });
      const groqPort = getGroqPort();

      await makeRequest(
        groqPort,
        {
          method: 'POST',
          path: '/openai/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
            connection: 'keep-alive',
            'keep-alive': 'timeout=5',
            'transfer-encoding': 'chunked',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
      expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
    });

    it('forwards request body correctly to Groq', async () => {
      await startProxies({ GROQ_API_KEY: 'groq-real-api-key' });
      const groqPort = getGroqPort();

      const requestBody = JSON.stringify({
        model: 'llama3-70b-8192',
        messages: [{ role: 'user', content: 'Test message' }],
        stream: false,
      });

      await makeRequest(
        groqPort,
        {
          method: 'POST',
          path: '/openai/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
          },
        },
        requestBody,
      );

      expect(lastUpstreamHeaders['authorization']).toBe('Bearer groq-real-api-key');
      expect(lastUpstreamHeaders['content-length']).toBe(requestBody.length.toString());
    });
  });

  describe('OpenAI routing', () => {
    beforeEach(async () => {
      mockEnv.OPENAI_API_KEY = 'sk-openai-real-key';
    });

    it('injects Authorization header with OPENAI_API_KEY', async () => {
      await startProxies({ OPENAI_API_KEY: 'sk-openai-real-key' });
      const openaiPort = getOpenaiPort();

      await makeRequest(
        openaiPort,
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

      expect(lastUpstreamHeaders['authorization']).toBe('Bearer sk-openai-real-key');
    });

    it('rewrites Host header to upstream server', async () => {
      await startProxies({ OPENAI_API_KEY: 'sk-openai-real-key' });
      const openaiPort = getOpenaiPort();

      await makeRequest(
        openaiPort,
        {
          method: 'POST',
          path: '/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['host']).toBe(`127.0.0.1:${upstreamPort}`);
    });

    it('routes OpenAI requests via dedicated port', async () => {
      await startProxies({ OPENAI_API_KEY: 'sk-openai-real-key' });
      const openaiPort = getOpenaiPort();

      await makeRequest(
        openaiPort,
        {
          method: 'POST',
          path: '/v1/embeddings',
          headers: {
            'content-type': 'application/json',
          },
        },
        '{"input":"test","model":"text-embedding-3-small"}',
      );

      expect(lastUpstreamHeaders['authorization']).toBe('Bearer sk-openai-real-key');
    });

    it('removes placeholder Authorization header before injecting real one', async () => {
      await startProxies({ OPENAI_API_KEY: 'sk-openai-real-key' });
      const openaiPort = getOpenaiPort();

      await makeRequest(
        openaiPort,
        {
          method: 'POST',
          path: '/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer fake-placeholder-key',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['authorization']).toBe('Bearer sk-openai-real-key');
      expect(lastUpstreamHeaders['authorization']).not.toBe(
        'Bearer fake-placeholder-key',
      );
    });

    it('strips hop-by-hop headers for OpenAI requests', async () => {
      await startProxies({ OPENAI_API_KEY: 'sk-openai-real-key' });
      const openaiPort = getOpenaiPort();

      await makeRequest(
        openaiPort,
        {
          method: 'POST',
          path: '/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
            connection: 'keep-alive',
            'keep-alive': 'timeout=5',
            'transfer-encoding': 'chunked',
          },
        },
        '{}',
      );

      expect(lastUpstreamHeaders['keep-alive']).toBeUndefined();
      expect(lastUpstreamHeaders['transfer-encoding']).toBeUndefined();
    });

    it('forwards request body correctly to OpenAI', async () => {
      await startProxies({ OPENAI_API_KEY: 'sk-openai-real-key' });
      const openaiPort = getOpenaiPort();

      const requestBody = JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Test message' }],
        stream: false,
      });

      await makeRequest(
        openaiPort,
        {
          method: 'POST',
          path: '/v1/chat/completions',
          headers: {
            'content-type': 'application/json',
          },
        },
        requestBody,
      );

      expect(lastUpstreamHeaders['authorization']).toBe('Bearer sk-openai-real-key');
      expect(lastUpstreamHeaders['content-length']).toBe(requestBody.length.toString());
    });
  });
});
