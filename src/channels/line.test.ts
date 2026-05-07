import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';

import {
  LineChannelAdapter,
  validateSignature,
  platformIdForSource,
  parsePlatformId,
  splitForLineLimit,
} from './line.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SECRET = 'test-channel-secret';
const TOKEN = 'test-access-token';

function sign(body: string | Buffer): string {
  return crypto.createHmac('sha256', SECRET).update(body).digest('base64');
}

describe('validateSignature', () => {
  it('accepts the correct signature', () => {
    const body = Buffer.from('{"events":[]}');
    expect(validateSignature(body, sign(body), SECRET)).toBe(true);
  });
  it('rejects a wrong signature', () => {
    const body = Buffer.from('{"events":[]}');
    expect(validateSignature(body, 'AAAA' + sign(body).slice(4), SECRET)).toBe(false);
  });
  it('rejects when signature is missing', () => {
    expect(validateSignature(Buffer.from(''), undefined, SECRET)).toBe(false);
  });
  it('rejects on length mismatch (no timing-safe equal would throw)', () => {
    expect(validateSignature(Buffer.from('x'), 'short', SECRET)).toBe(false);
  });
});

describe('platformIdForSource', () => {
  it('builds line:user:{id} for DM', () => {
    expect(platformIdForSource({ type: 'user', userId: 'U123' })).toBe('line:user:U123');
  });
  it('builds line:group:{id} for group', () => {
    expect(platformIdForSource({ type: 'group', groupId: 'C456', userId: 'U123' })).toBe('line:group:C456');
  });
  it('builds line:room:{id} for room', () => {
    expect(platformIdForSource({ type: 'room', roomId: 'R789', userId: 'U123' })).toBe('line:room:R789');
  });
  it('returns null when the source is missing the relevant id', () => {
    expect(platformIdForSource({ type: 'user' })).toBeNull();
    expect(platformIdForSource({ type: 'group' })).toBeNull();
  });
});

describe('parsePlatformId', () => {
  it('parses each kind', () => {
    expect(parsePlatformId('line:user:U1')).toEqual({ kind: 'user', id: 'U1' });
    expect(parsePlatformId('line:group:C1')).toEqual({ kind: 'group', id: 'C1' });
    expect(parsePlatformId('line:room:R1')).toEqual({ kind: 'room', id: 'R1' });
  });
  it('rejects unknown / malformed forms', () => {
    expect(parsePlatformId('line:U1')).toBeNull();
    expect(parsePlatformId('telegram:user:1')).toBeNull();
    expect(parsePlatformId('line:dm:U1')).toBeNull(); // 1.x asymmetric form
  });
});

describe('splitForLineLimit', () => {
  it('returns single chunk when within limit', () => {
    expect(splitForLineLimit('hello', 100)).toEqual(['hello']);
  });
  it('splits at exact-char boundaries', () => {
    expect(splitForLineLimit('abcdefghij', 3)).toEqual(['abc', 'def', 'ghi', 'j']);
  });
  it('honors the 5000-char default', () => {
    const long = 'x'.repeat(12000);
    const chunks = splitForLineLimit(long);
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.length).toBe(5000);
    expect(chunks[1]!.length).toBe(5000);
    expect(chunks[2]!.length).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Inbound webhook integration: spin up the adapter against an ephemeral port,
// post a real signed payload, and verify the ChannelSetup hooks fire.
// ---------------------------------------------------------------------------

function makeSetupSpy(): {
  config: ChannelSetup;
  inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }>;
  metadata: Array<{ platformId: string; name?: string; isGroup?: boolean }>;
} {
  const inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];
  const metadata: Array<{ platformId: string; name?: string; isGroup?: boolean }> = [];
  return {
    inbound,
    metadata,
    config: {
      onInbound: (platformId, threadId, message) => {
        inbound.push({ platformId, threadId, message });
      },
      onInboundEvent: () => {},
      onMetadata: (platformId, name, isGroup) => {
        metadata.push({ platformId, name, isGroup });
      },
      onAction: () => {},
    },
  };
}

async function postWebhook(port: number, body: string, signature: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/webhook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body).toString(),
          'X-Line-Signature': signature,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('LineChannelAdapter inbound webhook', () => {
  let adapter: LineChannelAdapter;
  let port: number;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  async function spinUp(setup: ChannelSetup): Promise<void> {
    adapter = new LineChannelAdapter({
      accessToken: TOKEN,
      channelSecret: SECRET,
      port: 0, // ephemeral
      path: '/webhook',
    });
    await adapter.setup(setup);
    port = ((adapter as unknown as { server: http.Server }).server.address() as AddressInfo).port;
  }

  beforeEach(() => {
    // Default fetch stub — profile/group lookups happen during inbound processing.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ displayName: 'Tanaka', userId: 'U1' }),
      text: () => Promise.resolve(''),
    } as Response);
  });

  afterEach(async () => {
    if (adapter) await adapter.teardown();
    fetchSpy.mockRestore();
  });

  it('rejects unsigned requests with 401', async () => {
    const setup = makeSetupSpy();
    await spinUp(setup.config);
    const body = JSON.stringify({ events: [] });
    const res = await postWebhook(port, body, 'wrong-sig');
    expect(res.status).toBe(401);
  });

  it('accepts a valid DM message and emits onInbound', async () => {
    const setup = makeSetupSpy();
    await spinUp(setup.config);

    const event = {
      events: [
        {
          type: 'message',
          source: { type: 'user', userId: 'U1' },
          timestamp: 1700000000000,
          message: { id: 'm1', type: 'text', text: 'hello bot' },
        },
      ],
    };
    const body = JSON.stringify(event);
    const res = await postWebhook(port, body, sign(body));
    expect(res.status).toBe(200);

    // Allow the async event processing to settle.
    await new Promise((r) => setTimeout(r, 30));

    expect(setup.inbound).toHaveLength(1);
    expect(setup.inbound[0]!.platformId).toBe('line:user:U1');
    expect(setup.inbound[0]!.threadId).toBeNull();
    const content = setup.inbound[0]!.message.content as { text: string; sender: string; senderId: string };
    expect(content.text).toBe('hello bot');
    expect(content.senderId).toBe('U1');
    expect(setup.inbound[0]!.message.isGroup).toBe(false);
  });

  it('handles group message and resolves group name + member display name', async () => {
    const setup = makeSetupSpy();
    await spinUp(setup.config);

    // Route fetches by URL — resolveDisplayName hits /member/, publishGroupName hits /summary.
    (fetchSpy as ReturnType<typeof vi.fn>).mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/summary')) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ groupName: 'JapanAI Startup' }),
          text: () => Promise.resolve(''),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ displayName: 'Tanaka', userId: 'U1' }),
        text: () => Promise.resolve(''),
      } as Response);
    });

    const event = {
      events: [
        {
          type: 'message',
          source: { type: 'group', groupId: 'C42', userId: 'U1' },
          timestamp: 1700000000000,
          message: { id: 'm2', type: 'text', text: 'group hello' },
        },
      ],
    };
    const body = JSON.stringify(event);
    await postWebhook(port, body, sign(body));
    await new Promise((r) => setTimeout(r, 50));

    expect(setup.inbound).toHaveLength(1);
    expect(setup.inbound[0]!.platformId).toBe('line:group:C42');
    expect(setup.inbound[0]!.message.isGroup).toBe(true);

    expect(
      setup.metadata.some(
        (m) => m.platformId === 'line:group:C42' && m.name === 'JapanAI Startup' && m.isGroup === true,
      ),
    ).toBe(true);
  });

  it('renders sticker messages as text placeholders', async () => {
    const setup = makeSetupSpy();
    await spinUp(setup.config);

    const event = {
      events: [
        {
          type: 'message',
          source: { type: 'user', userId: 'U1' },
          timestamp: 1700000000000,
          message: { id: 'sticker1', type: 'sticker', packageId: '11537', stickerId: '52002734' },
        },
      ],
    };
    const body = JSON.stringify(event);
    const res = await postWebhook(port, body, sign(body));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(setup.inbound).toHaveLength(1);
    expect(setup.inbound[0].message.content.text).toBe('[Sticker: 11537:52002734]');
  });

  it('drops unknown message types silently', async () => {
    const setup = makeSetupSpy();
    await spinUp(setup.config);

    const event = {
      events: [
        {
          type: 'message',
          source: { type: 'user', userId: 'U1' },
          timestamp: 1700000000000,
          message: { id: 'unknown1', type: 'imagemap' },
        },
      ],
    };
    const body = JSON.stringify(event);
    const res = await postWebhook(port, body, sign(body));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(setup.inbound).toHaveLength(0);
  });
});

describe('LineChannelAdapter outbound delivery', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let captured: Array<{ url: string; init: RequestInit }>;
  let adapter: LineChannelAdapter;

  beforeEach(async () => {
    captured = [];
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      captured.push({ url: String(url), init: init as RequestInit });
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ sentMessages: [{ id: 'sent-1' }] }),
        text: () => Promise.resolve(''),
      } as Response);
    });
    adapter = new LineChannelAdapter({
      accessToken: TOKEN,
      channelSecret: SECRET,
      port: 0,
      path: '/webhook',
    });
    const setup = makeSetupSpy();
    await adapter.setup(setup.config);
  });

  afterEach(async () => {
    await adapter.teardown();
    fetchSpy.mockRestore();
  });

  it('posts to /v2/bot/message/push with the parsed id', async () => {
    const id = await adapter.deliver('line:user:U1', null, { kind: 'chat', content: { text: 'hello' } });
    expect(id).toBe('sent-1');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe('https://api.line.me/v2/bot/message/push');
    const body = JSON.parse(captured[0]!.init.body as string);
    expect(body).toEqual({ to: 'U1', messages: [{ type: 'text', text: 'hello' }] });
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('chunks text over 5000 chars into multiple push calls', async () => {
    const long = 'x'.repeat(12000);
    await adapter.deliver('line:group:C1', null, { kind: 'chat', content: { text: long } });
    expect(captured).toHaveLength(3);
    expect(JSON.parse(captured[0]!.init.body as string).messages[0].text.length).toBe(5000);
    expect(JSON.parse(captured[2]!.init.body as string).messages[0].text.length).toBe(2000);
  });

  it('returns undefined for unknown platformId without calling LINE', async () => {
    const id = await adapter.deliver('garbage:1', null, { kind: 'chat', content: { text: 'x' } });
    expect(id).toBeUndefined();
    expect(captured).toHaveLength(0);
  });

  it('returns undefined when message has no text', async () => {
    const id = await adapter.deliver('line:user:U1', null, { kind: 'chat', content: {} });
    expect(id).toBeUndefined();
    expect(captured).toHaveLength(0);
  });
});
