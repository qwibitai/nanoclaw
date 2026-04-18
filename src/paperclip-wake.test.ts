import crypto from 'crypto';
import { AddressInfo } from 'net';

import { describe, expect, it, vi } from 'vitest';

import {
  computeSignature,
  createPaperclipWakeHandler,
  parseSignatureHeader,
  PaperclipWakePayload,
  startPaperclipWakeServer,
  verifyWakeAuth,
  WAKE_PATH,
} from './paperclip-wake.js';

const SILENT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function sigHeader(secret: string, ts: number, body: string): string {
  return `t=${ts},v1=${computeSignature(secret, ts, body)}`;
}

async function postRaw(
  baseUrl: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${baseUrl}${WAKE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

async function withServer<T>(
  opts: Parameters<typeof startPaperclipWakeServer>[0],
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = await startPaperclipWakeServer({
    logger: SILENT_LOGGER,
    ...opts,
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('parseSignatureHeader', () => {
  it('parses well-formed header', () => {
    const parsed = parseSignatureHeader('t=1700000000,v1=deadbeef');
    expect(parsed).toEqual({ timestampSeconds: 1700000000, mac: 'deadbeef' });
  });

  it('tolerates extra whitespace and unknown keys', () => {
    const parsed = parseSignatureHeader(
      '  v2=future ,  t = 42 , v1 = abc , ignore=x ',
    );
    expect(parsed).toEqual({ timestampSeconds: 42, mac: 'abc' });
  });

  it('returns null when missing fields', () => {
    expect(parseSignatureHeader('t=1')).toBeNull();
    expect(parseSignatureHeader('v1=abc')).toBeNull();
    expect(parseSignatureHeader('')).toBeNull();
    expect(parseSignatureHeader(undefined)).toBeNull();
  });

  it('returns null when t is not a number', () => {
    expect(parseSignatureHeader('t=nope,v1=abc')).toBeNull();
  });
});

describe('verifyWakeAuth', () => {
  const secret = 'hunter2';
  const body = '{"hello":"world"}';
  const now = 1_700_000_000;

  it('accepts valid bearer token', () => {
    const result = verifyWakeAuth({
      secret,
      headers: { authorization: `Bearer ${secret}` },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.method).toBe('bearer');
  });

  it('rejects wrong bearer token', () => {
    const result = verifyWakeAuth({
      secret,
      headers: { authorization: 'Bearer nope' },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
  });

  it('accepts valid HMAC signature', () => {
    const result = verifyWakeAuth({
      secret,
      headers: { 'x-paperclip-signature': sigHeader(secret, now, body) },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.method).toBe('hmac');
  });

  it('rejects HMAC with wrong secret', () => {
    const result = verifyWakeAuth({
      secret,
      headers: {
        'x-paperclip-signature': sigHeader('other-secret', now, body),
      },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects HMAC computed over a different body', () => {
    const result = verifyWakeAuth({
      secret,
      headers: {
        'x-paperclip-signature': sigHeader(secret, now, 'other-body'),
      },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects HMAC outside the replay window', () => {
    const result = verifyWakeAuth({
      secret,
      headers: {
        'x-paperclip-signature': sigHeader(secret, now - 3600, body),
      },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/replay window/);
  });

  it('accepts HMAC just inside the window (boundary)', () => {
    const result = verifyWakeAuth({
      secret,
      headers: {
        'x-paperclip-signature': sigHeader(secret, now - 300, body),
      },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when both auth methods are absent', () => {
    const result = verifyWakeAuth({
      secret,
      headers: {},
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/missing auth/);
  });

  it('rejects malformed signature header', () => {
    const result = verifyWakeAuth({
      secret,
      headers: { 'x-paperclip-signature': 'not-a-real-header' },
      rawBody: body,
      nowSeconds: now,
      replayWindowSeconds: 300,
    });
    expect(result.ok).toBe(false);
  });
});

describe('createPaperclipWakeHandler (in-process)', () => {
  it('throws if secret is empty', () => {
    expect(() =>
      createPaperclipWakeHandler({
        secret: '',
        onWake: () => {},
        logger: SILENT_LOGGER,
      }),
    ).toThrowError(/secret is required/);
  });
});

describe('paperclip-wake server (end-to-end)', () => {
  const secret = 'super-secret-xyz';

  it('returns 404 for wrong path', async () => {
    await withServer(
      {
        host: '127.0.0.1',
        port: 0,
        secret,
        onWake: () => {},
      },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/other`, { method: 'POST' });
        expect(res.status).toBe(404);
      },
    );
  });

  it('returns 404 for wrong method', async () => {
    await withServer(
      { host: '127.0.0.1', port: 0, secret, onWake: () => {} },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}${WAKE_PATH}`, { method: 'GET' });
        expect(res.status).toBe(404);
      },
    );
  });

  it('rejects unauthenticated POSTs with 401', async () => {
    await withServer(
      { host: '127.0.0.1', port: 0, secret, onWake: () => {} },
      async (baseUrl) => {
        const r = await postRaw(baseUrl, {}, '{}');
        expect(r.status).toBe(401);
      },
    );
  });

  it('accepts valid bearer and invokes onWake with parsed payload', async () => {
    const onWake = vi.fn<(p: PaperclipWakePayload, raw: string) => void>();
    const body = JSON.stringify({
      agentId: 'agent-1',
      runId: 'run-xyz',
      context: { wakeReason: 'issue_commented', chatJid: 'chat@example' },
    });

    await withServer(
      {
        host: '127.0.0.1',
        port: 0,
        secret,
        onWake,
      },
      async (baseUrl) => {
        const r = await postRaw(
          baseUrl,
          { authorization: `Bearer ${secret}` },
          body,
        );
        expect(r.status).toBe(202);
        const parsed = JSON.parse(r.body);
        expect(parsed).toMatchObject({
          accepted: true,
          runId: 'run-xyz',
          agentId: 'agent-1',
        });
      },
    );

    // onWake is invoked after the response resolves — poll until the call lands.
    await vi.waitFor(() => expect(onWake).toHaveBeenCalledOnce());
    const [payload, raw] = onWake.mock.calls[0];
    expect(payload.agentId).toBe('agent-1');
    expect(payload.context?.wakeReason).toBe('issue_commented');
    expect(raw).toBe(body);
  });

  it('accepts valid HMAC signature', async () => {
    const onWake = vi.fn<(p: PaperclipWakePayload, raw: string) => void>();
    const body = JSON.stringify({ agentId: 'a', runId: 'r' });
    const ts = Math.floor(Date.now() / 1000);

    await withServer(
      { host: '127.0.0.1', port: 0, secret, onWake },
      async (baseUrl) => {
        const r = await postRaw(
          baseUrl,
          { 'x-paperclip-signature': sigHeader(secret, ts, body) },
          body,
        );
        expect(r.status).toBe(202);
      },
    );
    await vi.waitFor(() => expect(onWake).toHaveBeenCalledOnce());
  });

  it('rejects bodies larger than the configured limit with 413', async () => {
    await withServer(
      {
        host: '127.0.0.1',
        port: 0,
        secret,
        maxBodyBytes: 64,
        onWake: () => {},
      },
      async (baseUrl) => {
        const body = JSON.stringify({ blob: 'x'.repeat(500) });
        const r = await postRaw(
          baseUrl,
          { authorization: `Bearer ${secret}` },
          body,
        );
        expect(r.status).toBe(413);
      },
    );
  });

  it('rejects invalid JSON with 400 after auth passes', async () => {
    await withServer(
      { host: '127.0.0.1', port: 0, secret, onWake: () => {} },
      async (baseUrl) => {
        const r = await postRaw(
          baseUrl,
          { authorization: `Bearer ${secret}` },
          'not-json{',
        );
        expect(r.status).toBe(400);
      },
    );
  });

  it('swallows onWake handler errors but still returns 202', async () => {
    const errors: unknown[] = [];
    const loggerWithCapture = {
      ...SILENT_LOGGER,
      error: (obj: unknown) => {
        errors.push(obj);
      },
    };
    await withServer(
      {
        host: '127.0.0.1',
        port: 0,
        secret,
        logger: loggerWithCapture,
        onWake: async () => {
          throw new Error('boom');
        },
      },
      async (baseUrl) => {
        const r = await postRaw(
          baseUrl,
          { authorization: `Bearer ${secret}` },
          '{"runId":"r"}',
        );
        expect(r.status).toBe(202);
      },
    );
    // onWake runs after the response resolves; poll until the catch fires.
    await vi.waitFor(() => expect(errors.length).toBe(1));
  });

  it('signs and verifies a round trip for the documented canonical form', () => {
    // Pinned reference: if you change computeSignature you must change here too.
    const ref = crypto
      .createHmac('sha256', 'k')
      .update('100.{"a":1}')
      .digest('hex');
    expect(computeSignature('k', 100, '{"a":1}')).toBe(ref);
  });
});
