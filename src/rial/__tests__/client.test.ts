import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { buildAuthHeader, RialApiError, RialClient } from '../client.js';
import { RialConfig } from '../secrets.js';

const baseConfig: RialConfig = {
  apiBaseUrl: 'https://api.example.com',
  hmacSecret: 'a'.repeat(64),
  notifyQueueUrl: '',
  awsRegion: 'us-east-1',
  userAgent: 'rialclaw/test',
};

function makeFetchMock(
  handler: (
    input: string | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): {
  fn: typeof fetch;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return handler(input, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('buildAuthHeader', () => {
  it('produces ts:hmac with the documented message format', () => {
    const ts = 1_700_000_000;
    const method = 'POST';
    const path = '/v1/wa-links/init';
    const body = JSON.stringify({ tenantId: 't_1' });
    const header = buildAuthHeader('secret', ts, method, path, body);

    const bodyHash = createHash('sha256').update(body).digest('hex');
    const expected = createHmac('sha256', 'secret')
      .update(`${ts}\n${method}\n${path}\n${bodyHash}`)
      .digest('hex');

    expect(header).toBe(`${ts}:${expected}`);
  });

  it('uses an empty-body hash when body is empty', () => {
    const ts = 1_700_000_000;
    const header = buildAuthHeader('secret', ts, 'GET', '/v1/x', '');
    const emptyHash = createHash('sha256').update('').digest('hex');
    const expected = createHmac('sha256', 'secret')
      .update(`${ts}\nGET\n/v1/x\n${emptyHash}`)
      .digest('hex');
    expect(header).toBe(`${ts}:${expected}`);
  });
});

describe('RialClient', () => {
  it('sends the X-Bot-Auth header with HMAC', async () => {
    const { fn, calls } = makeFetchMock(
      () =>
        new Response(JSON.stringify({ tenantId: 't_1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const now = () => 1_700_000_000_000;
    const client = new RialClient({ config: baseConfig, fetchImpl: fn, now });
    const r = await client.resolveTenant('+5491100000001');
    expect(r.tenantId).toBe('t_1');

    expect(calls).toHaveLength(1);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toBe('rialclaw/test');
    const auth = headers['X-Bot-Auth'];
    expect(auth).toMatch(/^1700000000:[0-9a-f]{64}$/);
  });

  it('signs only the path, not the query string', async () => {
    const { fn, calls } = makeFetchMock(
      () => new Response('{"tenantId":"t_1"}', { status: 200 }),
    );
    const now = () => 1_700_000_000_000;
    const client = new RialClient({ config: baseConfig, fetchImpl: fn, now });
    await client.resolveTenant('+5491100000001');

    const auth = (calls[0].init?.headers as Record<string, string>)[
      'X-Bot-Auth'
    ];
    const expected = buildAuthHeader(
      baseConfig.hmacSecret,
      1_700_000_000,
      'GET',
      '/v1/wa-links/resolve',
      '',
    );
    expect(auth).toBe(expected);
  });

  it('encodes the body and matches its hash in the signature', async () => {
    const { fn, calls } = makeFetchMock(
      () =>
        new Response('{"id":"vfy_1","url":"https://x","expiresInMinutes":10}', {
          status: 200,
        }),
    );
    const now = () => 1_700_000_000_000;
    const client = new RialClient({ config: baseConfig, fetchImpl: fn, now });
    await client.createVerification('t_1', '+5491100000001');

    const init = calls[0].init!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe(
      JSON.stringify({ tenantId: 't_1', waPhoneE164: '+5491100000001' }),
    );
    const auth = (init.headers as Record<string, string>)['X-Bot-Auth'];
    const expected = buildAuthHeader(
      baseConfig.hmacSecret,
      1_700_000_000,
      'POST',
      '/v1/wa-links/init',
      init.body as string,
    );
    expect(auth).toBe(expected);
  });

  it('maps 404 to RialApiError with kind=not-found', async () => {
    const { fn } = makeFetchMock(
      () => new Response('not found', { status: 404 }),
    );
    const client = new RialClient({ config: baseConfig, fetchImpl: fn });
    await expect(client.getVerification('vfy_x')).rejects.toMatchObject({
      name: 'RialApiError',
      kind: 'not-found',
      status: 404,
    });
  });

  it('maps 5xx to kind=server-error', async () => {
    const { fn } = makeFetchMock(() => new Response('boom', { status: 503 }));
    const client = new RialClient({ config: baseConfig, fetchImpl: fn });
    await expect(client.resolveTenant('+5491100000001')).rejects.toMatchObject({
      name: 'RialApiError',
      kind: 'server-error',
    });
  });

  it('maps 401/403 to kind=unauthorized', async () => {
    const { fn } = makeFetchMock(() => new Response('nope', { status: 401 }));
    const client = new RialClient({ config: baseConfig, fetchImpl: fn });
    await expect(client.resolveTenant('+5491100000001')).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  it('maps 429 to kind=rate-limited', async () => {
    const { fn } = makeFetchMock(
      () => new Response('slow down', { status: 429 }),
    );
    const client = new RialClient({ config: baseConfig, fetchImpl: fn });
    await expect(client.resolveTenant('+5491100000001')).rejects.toMatchObject({
      kind: 'rate-limited',
    });
  });

  it('maps abort/timeout to kind=timeout', async () => {
    const { fn } = makeFetchMock((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        // Simulate a hanging request that the client aborts.
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted') as Error & { name: string };
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });
    const client = new RialClient({
      config: baseConfig,
      fetchImpl: fn,
      timeoutMs: 5,
    });
    const err = await client.resolveTenant('+5491100000001').catch((e) => e);
    expect(err).toBeInstanceOf(RialApiError);
    expect(err.kind).toBe('timeout');
  });

  it('maps generic fetch errors to kind=network', async () => {
    const { fn } = makeFetchMock(() => {
      throw new Error('ECONNRESET');
    });
    const client = new RialClient({ config: baseConfig, fetchImpl: fn });
    await expect(client.resolveTenant('+5491100000001')).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('maps non-JSON responses to kind=invalid-response', async () => {
    const { fn } = makeFetchMock(
      () => new Response('not-json', { status: 200 }),
    );
    const client = new RialClient({ config: baseConfig, fetchImpl: fn });
    await expect(client.resolveTenant('+5491100000001')).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });
});
