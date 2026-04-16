import { createHmac } from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger before any imports that use it
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock event-bus so we can spy on emits without side effects.
// The factory must not reference variables declared in module scope (vi.mock is hoisted).
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import net from 'net';

import { eventBus } from '../event-bus.js';
import {
  validateWebhookSignature,
  parseWebhookPayload,
  startWebhookServer,
} from './webhook-server.js';

// Cast to a spy so we can inspect calls
const mockEmit = vi.mocked(eventBus.emit);

/** Finds a free TCP port by binding to :0 and immediately releasing it. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSignature(body: string, secret: string): string {
  const hex = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

async function postTo(
  port: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://localhost:${port}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  return { status: res.status, text: await res.text() };
}

// ---------------------------------------------------------------------------
// validateWebhookSignature
// ---------------------------------------------------------------------------

describe('validateWebhookSignature', () => {
  const secret = 'test-secret-key';
  const body = JSON.stringify({ event: 'push', ref: 'refs/heads/main' });

  it('accepts a valid HMAC-SHA256 signature', () => {
    const sig = makeSignature(body, secret);
    expect(validateWebhookSignature(body, sig, secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = makeSignature(body, secret);
    expect(validateWebhookSignature(body + ' tampered', sig, secret)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = makeSignature(body, 'other-secret');
    expect(validateWebhookSignature(body, sig, secret)).toBe(false);
  });

  it('rejects a signature without sha256= prefix', () => {
    const hex = createHmac('sha256', secret).update(body).digest('hex');
    expect(validateWebhookSignature(body, hex, secret)).toBe(false);
  });

  it('rejects an empty signature string', () => {
    expect(validateWebhookSignature(body, '', secret)).toBe(false);
  });

  it('rejects a malformed hex after sha256= prefix', () => {
    expect(validateWebhookSignature(body, 'sha256=nothex!', secret)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseWebhookPayload
// ---------------------------------------------------------------------------

describe('parseWebhookPayload', () => {
  it('wraps payload into a NanoClawEvent with correct structure', () => {
    const raw = { action: 'opened', number: 42 };
    const event = parseWebhookPayload('github', raw);

    expect(event.type).toBe('webhook.github');
    expect(event.source).toBe('webhook');
    expect(typeof event.timestamp).toBe('number');
    expect(event.payload).toEqual({ webhookSource: 'github', data: raw });
  });

  it('uses the provided source in the event type', () => {
    const event = parseWebhookPayload('notion', { page_id: 'abc' });
    expect(event.type).toBe('webhook.notion');
    expect(event.payload).toMatchObject({ webhookSource: 'notion' });
  });

  it('handles an empty payload object gracefully', () => {
    const event = parseWebhookPayload('generic', {});
    expect(event.type).toBe('webhook.generic');
    expect(event.payload).toEqual({ webhookSource: 'generic', data: {} });
  });

  it('preserves nested payload data without modification', () => {
    const nested = { a: { b: { c: [1, 2, 3] } }, flag: true };
    const event = parseWebhookPayload('custom', nested);
    expect((event.payload as Record<string, unknown>).data).toEqual(nested);
  });
});

// ---------------------------------------------------------------------------
// startWebhookServer — integration-style tests using real HTTP
// ---------------------------------------------------------------------------

describe('startWebhookServer', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let port: number;
  const secret = 'integration-secret';

  beforeEach(async () => {
    mockEmit.mockClear();
    // Find a free port first, then start the server on that port
    port = await getFreePort();
    server = startWebhookServer(port, secret);
    await new Promise<void>((resolve) => server.once('listening', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 405 for GET requests', async () => {
    const res = await fetch(`http://localhost:${port}`, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('returns 405 for PUT requests', async () => {
    const res = await fetch(`http://localhost:${port}`, { method: 'PUT', body: '{}' });
    expect(res.status).toBe(405);
  });

  it('returns 401 when signature is missing', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const { status } = await postTo(port, body);
    expect(status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('returns 401 for invalid HMAC signature', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const { status } = await postTo(port, body, {
      'x-hub-signature-256': 'sha256=deadbeef',
    });
    expect(status).toBe(401);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('returns 200 and emits event for valid signature', async () => {
    const body = JSON.stringify({ action: 'push' });
    const sig = makeSignature(body, secret);
    const { status, text } = await postTo(port, body, {
      'x-hub-signature-256': sig,
      'x-webhook-source': 'github',
    });
    expect(status).toBe(200);
    expect(text).toBe('OK');
    expect(mockEmit).toHaveBeenCalledOnce();
    const [, event] = mockEmit.mock.calls[0] as [string, { type: string; payload: { webhookSource: string } }];
    expect(event.type).toBe('webhook.github');
    expect(event.payload.webhookSource).toBe('github');
  });

  it('defaults source to "generic" when x-webhook-source header is absent', async () => {
    const body = JSON.stringify({ data: 1 });
    const sig = makeSignature(body, secret);
    await postTo(port, body, { 'x-hub-signature-256': sig });
    expect(mockEmit).toHaveBeenCalledOnce();
    const [, event] = mockEmit.mock.calls[0] as [string, { type: string }];
    expect(event.type).toBe('webhook.generic');
  });

  it('returns 400 for malformed JSON body', async () => {
    const body = 'not json {{';
    const sig = makeSignature(body, secret);
    const { status } = await postTo(port, body, {
      'x-hub-signature-256': sig,
    });
    expect(status).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('returns 400 when body is a JSON array (not an object)', async () => {
    const body = JSON.stringify([1, 2, 3]);
    const sig = makeSignature(body, secret);
    const { status } = await postTo(port, body, {
      'x-hub-signature-256': sig,
    });
    expect(status).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// startWebhookServer — secret-less mode (signature validation skipped)
// ---------------------------------------------------------------------------

describe('startWebhookServer (no secret)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let port: number;

  beforeEach(async () => {
    mockEmit.mockClear();
    port = await getFreePort();
    server = startWebhookServer(port, ''); // empty secret → skip validation
    await new Promise<void>((resolve) => server.once('listening', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('accepts requests without any signature header', async () => {
    const body = JSON.stringify({ open: true });
    const { status } = await postTo(port, body);
    expect(status).toBe(200);
    expect(mockEmit).toHaveBeenCalledOnce();
  });

  it('still rejects bad JSON even without signature requirement', async () => {
    const { status } = await postTo(port, 'bad json');
    expect(status).toBe(400);
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// startWebhookServer — disabled (port 0)
// ---------------------------------------------------------------------------

describe('startWebhookServer disabled', () => {
  it('returns null when port is 0', () => {
    const result = startWebhookServer(0, 'any-secret');
    expect(result).toBeNull();
  });
});
