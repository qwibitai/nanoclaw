import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';

import type { ChannelOpts } from './registry.js';
import type { Channel, NewMessage, RegisteredGroup } from '../types.js';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let mockApiToken = 'test-secret-token';
vi.mock('../config.js', () => ({
  get ASSISTANT_NAME() {
    return 'TestBot';
  },
  get API_PORT() {
    return 0;
  }, // OS picks free port
  get API_TIMEOUT() {
    return 3000;
  },
  get API_TOKEN() {
    return mockApiToken;
  },
}));

// --- Helpers ---

const TEST_GROUP: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@TestBot',
  added_at: new Date().toISOString(),
};

function makeOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({ 'telegram:123': TEST_GROUP }),
    ...overrides,
  };
}

type ApiChannel = Channel & { port(): number };

async function req(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: { 'Content-Type': 'application/json', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString('utf-8'),
            headers: res.headers,
          }),
        );
        res.on('error', reject);
      },
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// --- Import after mocks ---

import { createApiChannel } from './api.js';

// --- Tests ---

describe('API channel', () => {
  let channel: ApiChannel | null = null;
  let opts: ChannelOpts;

  afterEach(async () => {
    if (channel) {
      await channel.disconnect();
      channel = null;
    }
  });

  it('returns null when API_TOKEN is empty', () => {
    const saved = mockApiToken;
    mockApiToken = '';
    try {
      const ch = createApiChannel(makeOpts());
      expect(ch).toBeNull();
    } finally {
      mockApiToken = saved;
    }
  });

  it('connects and reports isConnected', async () => {
    opts = makeOpts();
    channel = createApiChannel(opts) as ApiChannel;
    expect(channel).not.toBeNull();
    expect(channel!.isConnected()).toBe(false);
    await channel!.connect();
    expect(channel!.isConnected()).toBe(true);
  });

  it('ownsJid returns false when no pending requests', async () => {
    opts = makeOpts();
    channel = createApiChannel(opts) as ApiChannel;
    await channel!.connect();
    expect(channel!.ownsJid('telegram:123')).toBe(false);
  });
});

describe('API channel HTTP endpoints', () => {
  let channel: ApiChannel;
  let port: number;
  let opts: ChannelOpts;

  beforeEach(async () => {
    opts = makeOpts();
    channel = createApiChannel(opts) as ApiChannel;
    await channel.connect();
    port = channel.port();
  });

  afterEach(async () => {
    if (channel) await channel.disconnect();
  });

  // ── Health ───────────────────────────────────────────

  it('GET /api/v1/health returns 200 with correct shape', async () => {
    const res = await req(port, 'GET', '/api/v1/health');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.bot).toBe('TestBot');
    expect(typeof body.registeredGroups).toBe('number');
    expect(typeof body.uptime).toBe('number');
  });

  it('health endpoint does not require auth', async () => {
    const res = await req(port, 'GET', '/api/v1/health');
    expect(res.status).toBe(200);
  });

  // ── Auth ─────────────────────────────────────────────

  it('rejects missing auth with 401', async () => {
    const res = await req(port, 'POST', '/api/v1/message', {
      group: 'test-group',
      sender: 'user',
      sender_name: 'User',
      content: 'hello',
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid auth with 401', async () => {
    const res = await req(
      port,
      'POST',
      '/api/v1/message',
      {
        group: 'test-group',
        sender: 'user',
        sender_name: 'User',
        content: 'hello',
      },
      { Authorization: 'Bearer wrong-token' },
    );
    expect(res.status).toBe(401);
  });

  // ── Validation ───────────────────────────────────────

  it('rejects missing fields with 400', async () => {
    const res = await req(
      port,
      'POST',
      '/api/v1/message',
      { group: 'test-group' }, // missing sender, sender_name, content
      { Authorization: 'Bearer test-secret-token' },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(
      /Missing required fields|must be non-empty strings/,
    );
  });

  it('rejects unknown group with 404', async () => {
    const res = await req(
      port,
      'POST',
      '/api/v1/message',
      {
        group: 'nonexistent-group',
        sender: 'user',
        sender_name: 'User',
        content: 'hello',
      },
      { Authorization: 'Bearer test-secret-token' },
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await req(port, 'GET', '/api/v1/nope');
    expect(res.status).toBe(404);
  });

  // ── Message round-trip ───────────────────────────────

  it('successful message round-trip (sync)', async () => {
    // Send the request — it will block until sendMessage is called
    const httpPromise = req(
      port,
      'POST',
      '/api/v1/message',
      {
        group: 'test-group',
        sender: 'alice',
        sender_name: 'Alice',
        content: 'what time is it?',
      },
      { Authorization: 'Bearer test-secret-token' },
    );

    // Wait a tick for the request to register
    await new Promise((r) => setTimeout(r, 50));

    // Verify onMessage was called
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = (opts.onMessage as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, NewMessage];
    expect(jid).toBe('telegram:123');
    expect(msg.sender).toBe('alice');
    expect(msg.sender_name).toBe('Alice');
    expect(msg.content).toContain('@TestBot what time is it?');

    // ownsJid should be true while request is pending
    expect(channel.ownsJid('telegram:123')).toBe(true);

    // Simulate agent response via sendMessage + endMessage
    await channel.sendMessage('telegram:123', 'It is 3pm');

    // ownsJid should still be true — endMessage hasn't been called yet
    expect(channel.ownsJid('telegram:123')).toBe(true);

    await channel.endMessage!('telegram:123');

    const res = await httpPromise;
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response).toBe('It is 3pm');
    expect(typeof body.elapsed_ms).toBe('number');

    // ownsJid should be false after endMessage
    expect(channel.ownsJid('telegram:123')).toBe(false);
  });

  // ── SSE streaming ────────────────────────────────────

  it('SSE streaming sends chunks as events', async () => {
    const chunks: string[] = [];

    // Start the streaming request
    const ssePromise = new Promise<{ status: number; events: string[] }>(
      (resolve, reject) => {
        const r = http.request(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/api/v1/message',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer test-secret-token',
            },
          },
          (res) => {
            const events: string[] = [];
            res.on('data', (chunk: Buffer) => {
              events.push(chunk.toString('utf-8'));
            });
            res.on('end', () => resolve({ status: res.statusCode!, events }));
            res.on('error', reject);
          },
        );
        r.on('error', reject);
        r.write(
          JSON.stringify({
            group: 'test-group',
            sender: 'bob',
            sender_name: 'Bob',
            content: 'stream me',
            stream: true,
          }),
        );
        r.end();
      },
    );

    // Wait for the request to register
    await new Promise((r) => setTimeout(r, 50));

    // Send multiple chunks
    await channel.sendMessage('telegram:123', 'chunk 1');
    await channel.sendMessage('telegram:123', 'chunk 2');

    // Signal completion — sends terminal `event: done` and closes the stream
    await channel.endMessage!('telegram:123');

    const result = await ssePromise;
    expect(result.status).toBe(200);

    // The events should contain our chunks and a terminal done event
    const allData = result.events.join('');
    expect(allData).toContain('"content":"chunk 1"');
    expect(allData).toContain('"content":"chunk 2"');
    expect(allData).toContain('event: message');
    expect(allData).toContain('event: done');
    expect(allData).toContain('elapsed_ms');
  });

  // ── Timeout ──────────────────────────────────────────

  it('timeout produces 408', async () => {
    // API_TIMEOUT is mocked to 3000ms
    const res = await req(
      port,
      'POST',
      '/api/v1/message',
      {
        group: 'test-group',
        sender: 'charlie',
        sender_name: 'Charlie',
        content: 'slow request',
      },
      { Authorization: 'Bearer test-secret-token' },
    );

    // This will take ~3s to timeout
    expect(res.status).toBe(408);
    expect(JSON.parse(res.body).error).toBe('Request timed out');
  }, 10000);

  // ── Shutdown ─────────────────────────────────────────

  it('graceful shutdown rejects new requests with 503', async () => {
    await channel.disconnect();

    // Reconnect on a new instance to test the 503 path
    // Actually, after disconnect, the server is closed so we can't connect.
    // Instead, test by starting a request, then disconnecting mid-flight.
    const channel2 = createApiChannel(opts) as ApiChannel;
    await channel2.connect();
    const port2 = channel2.port();

    // Start a long-running request
    const httpPromise = req(
      port2,
      'POST',
      '/api/v1/message',
      {
        group: 'test-group',
        sender: 'dave',
        sender_name: 'Dave',
        content: 'about to shutdown',
      },
      { Authorization: 'Bearer test-secret-token' },
    );

    await new Promise((r) => setTimeout(r, 50));

    // Disconnect while request is pending — should drain with 503
    await channel2.disconnect();

    const res = await httpPromise;
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error).toBe('Server shutting down');

    // Reassign channel for cleanup
    channel = null as unknown as ApiChannel; // already disconnected
  });

  // ── Duplicate request ────────────────────────────────

  it('rejects duplicate request for same group with 409', async () => {
    // Start first request
    const first = req(
      port,
      'POST',
      '/api/v1/message',
      {
        group: 'test-group',
        sender: 'eve',
        sender_name: 'Eve',
        content: 'first',
      },
      { Authorization: 'Bearer test-secret-token' },
    );

    await new Promise((r) => setTimeout(r, 50));

    // Try second request for same group
    const second = await req(
      port,
      'POST',
      '/api/v1/message',
      {
        group: 'test-group',
        sender: 'frank',
        sender_name: 'Frank',
        content: 'second',
      },
      { Authorization: 'Bearer test-secret-token' },
    );

    expect(second.status).toBe(409);

    // Clean up first request
    await channel.sendMessage('telegram:123', 'done');
    await channel.endMessage!('telegram:123');
    await first;
  });
});
