import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

vi.mock('./config.js', () => ({
  CREDENTIAL_PROXY_PORT: 0, // will be overridden per-test
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./cases.js', () => ({}));

import * as config from './config.js';
import { callHaiku } from './case-router.js';

describe('callHaiku', () => {
  let server: http.Server;
  let serverPort: number;

  afterEach(() => {
    if (server) {
      server.close();
    }
  });

  function startFakeProxy(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<number> {
    return new Promise((resolve) => {
      server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as AddressInfo).port;
        serverPort = port;
        // Override the mocked CREDENTIAL_PROXY_PORT
        Object.defineProperty(config, 'CREDENTIAL_PROXY_PORT', {
          value: port,
          writable: true,
          configurable: true,
        });
        resolve(port);
      });
    });
  }

  /**
   * INVARIANT: callHaiku routes through credential proxy at 127.0.0.1:CREDENTIAL_PROXY_PORT
   * SUT: the HTTP request target
   * VERIFICATION: a fake server on 127.0.0.1 receives the request
   */
  it('routes requests to 127.0.0.1 on the credential proxy port', async () => {
    let receivedReq: http.IncomingMessage | undefined;

    await startFakeProxy((req, res) => {
      receivedReq = req;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ text: '{"case_number": 1, "confidence": 0.9}' }],
        }),
      );
    });

    const result = await callHaiku('test prompt');

    expect(receivedReq).toBeDefined();
    expect(receivedReq!.method).toBe('POST');
    expect(receivedReq!.url).toBe('/v1/messages');
    expect(result).toBe('{"case_number": 1, "confidence": 0.9}');
  });

  /**
   * INVARIANT: No API key or secrets are included in the request headers
   * SUT: request headers passed to httpRequest
   * VERIFICATION: the received request has no x-api-key header
   */
  it('does not include x-api-key header in requests', async () => {
    let receivedHeaders: http.IncomingHttpHeaders | undefined;

    await startFakeProxy((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ text: 'ok' }],
        }),
      );
    });

    await callHaiku('test prompt');

    expect(receivedHeaders).toBeDefined();
    expect(receivedHeaders!['x-api-key']).toBeUndefined();
  });

  /**
   * INVARIANT: anthropic-version header is present
   * SUT: request headers
   * VERIFICATION: the received request contains anthropic-version: 2023-06-01
   */
  it('includes anthropic-version header', async () => {
    let receivedHeaders: http.IncomingHttpHeaders | undefined;

    await startFakeProxy((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ text: 'ok' }],
        }),
      );
    });

    await callHaiku('test prompt');

    expect(receivedHeaders!['anthropic-version']).toBe('2023-06-01');
  });

  /**
   * INVARIANT: Haiku response text is extracted and trimmed correctly
   * SUT: callHaiku return value
   * VERIFICATION: the returned string matches the text field from the API response
   */
  it('parses and returns the text from a successful Haiku response', async () => {
    await startFakeProxy((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ text: '  {"case_number": 2, "confidence": 0.75}  ' }],
        }),
      );
    });

    const result = await callHaiku('classify this message');

    expect(result).toBe('{"case_number": 2, "confidence": 0.75}');
  });

  /**
   * INVARIANT: callHaiku rejects when response has no content text
   * SUT: callHaiku error handling
   * VERIFICATION: promise rejects with descriptive error
   */
  it('rejects when response has unexpected structure', async () => {
    await startFakeProxy((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
    });

    await expect(callHaiku('test')).rejects.toThrow(
      'Unexpected Haiku response',
    );
  });

  /**
   * INVARIANT: Request body contains correct model and prompt
   * SUT: the HTTP request body sent to the proxy
   * VERIFICATION: parsed body matches expected model, max_tokens, and message content
   */
  it('sends correct model and prompt in request body', async () => {
    let receivedBody = '';

    await startFakeProxy((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content: [{ text: 'ok' }] }));
      });
    });

    await callHaiku('my test prompt');

    const parsed = JSON.parse(receivedBody);
    expect(parsed.model).toBe('claude-haiku-4-5-20251001');
    expect(parsed.max_tokens).toBe(150);
    expect(parsed.messages).toEqual([
      { role: 'user', content: 'my test prompt' },
    ]);
  });
});
