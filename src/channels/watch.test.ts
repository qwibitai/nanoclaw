import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

// --- Mocks ---

vi.mock('../config.js', () => ({
  STORE_DIR: path.join(os.tmpdir(), 'nanoclaw-watch-test'),
  WATCH_AUTH_TOKEN: 'test-token-abc',
  WATCH_GROUP_FOLDER: 'main',
  WATCH_HTTP_BIND: '127.0.0.1',
  WATCH_HTTP_PORT: 0, // OS picks a free port
  WATCH_JID: 'watch:test',
  WATCH_SYNC_TIMEOUT_MS: 200,
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../db.js', () => ({
  getRegisteredGroup: vi.fn(() => undefined),
  setRegisteredGroup: vi.fn(),
}));

const mockTranscribe = vi.fn<(p: string) => Promise<string>>();
vi.mock('../transcription.js', () => ({
  transcribeAudio: (p: string) => mockTranscribe(p),
}));

import { WatchChannel, WatchChannelOpts } from './watch.js';

// --- Test helpers ---

function createOpts(): WatchChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  };
}

function getPort(channel: WatchChannel): number {
  const srv = (channel as unknown as { server: http.Server }).server;
  return (srv.address() as AddressInfo).port;
}

async function makeRequest(
  port: number,
  method: string,
  reqPath: string,
  headers: Record<string, string> = {},
  body?: Buffer | string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const bodyBuf =
      body == null
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(body, 'utf-8');
    const finalHeaders = { ...headers };
    if (bodyBuf) finalHeaders['Content-Length'] = String(bodyBuf.length);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path: reqPath,
        headers: finalHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

const AUTH = { 'X-Watch-Token': 'test-token-abc' };

// --- Tests ---

describe('WatchChannel', () => {
  let channel: WatchChannel;
  let opts: WatchChannelOpts;

  beforeEach(async () => {
    mockTranscribe.mockReset();
    opts = createOpts();
    channel = new WatchChannel(opts);
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  // -- ownsJid --

  describe('ownsJid', () => {
    it('owns its configured JID', () => {
      expect(channel.ownsJid('watch:test')).toBe(true);
    });
    it('does not own other JIDs', () => {
      expect(channel.ownsJid('watch:other')).toBe(false);
      expect(channel.ownsJid('signal:+15551234567')).toBe(false);
    });
  });

  // -- auth --

  describe('auth', () => {
    it('rejects requests without X-Watch-Token', async () => {
      const res = await makeRequest(
        getPort(channel),
        'GET',
        '/api/watch/poll?device_id=x',
      );
      expect(res.status).toBe(401);
    });

    it('rejects requests with a wrong X-Watch-Token', async () => {
      const res = await makeRequest(
        getPort(channel),
        'GET',
        '/api/watch/poll?device_id=x',
        { 'X-Watch-Token': 'wrong-token' },
      );
      expect(res.status).toBe(401);
    });

    it('accepts requests with the correct X-Watch-Token', async () => {
      const res = await makeRequest(
        getPort(channel),
        'GET',
        '/api/watch/poll?device_id=x',
        AUTH,
      );
      expect(res.status).toBe(200);
    });
  });

  // -- POST /api/watch/message text --

  describe('POST /api/watch/message (text)', () => {
    it('returns 400 when the JSON body has no text field', async () => {
      const res = await makeRequest(
        getPort(channel),
        'POST',
        '/api/watch/message',
        { ...AUTH, 'Content-Type': 'application/json' },
        JSON.stringify({ device_id: 'twatch-s3' }),
      );
      expect(res.status).toBe(400);
    });

    it('fires onMessage and returns the sync reply (fast path)', async () => {
      const pending = makeRequest(
        getPort(channel),
        'POST',
        '/api/watch/message',
        { ...AUTH, 'Content-Type': 'application/json' },
        JSON.stringify({ text: 'hello jorgenclaw', device_id: 'twatch-s3' }),
      );

      // Give the handler a tick to register the resolver + fire onMessage
      await new Promise((r) => setTimeout(r, 20));
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      const mockCalls = (
        opts.onMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const [jid, msg] = mockCalls[0] as [
        string,
        { content: string; is_from_me: boolean },
      ];
      expect(jid).toBe('watch:test');
      expect(msg.content).toBe('hello jorgenclaw');
      expect(msg.is_from_me).toBe(true);

      // Simulate the agent replying — should unblock the pending request
      await channel.sendMessage('watch:test', 'hi scott');

      const res = await pending;
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ reply: 'hi scott' });
    });

    it('falls back to empty reply on sync timeout (slow path)', async () => {
      const res = await makeRequest(
        getPort(channel),
        'POST',
        '/api/watch/message',
        { ...AUTH, 'Content-Type': 'application/json' },
        JSON.stringify({ text: 'slow one', device_id: 'twatch-s3' }),
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ reply: '' });
      // Late reply should then land in the poll queue instead
      await channel.sendMessage('watch:test', 'late reply');
      const pollRes = await makeRequest(
        getPort(channel),
        'GET',
        '/api/watch/poll?device_id=twatch-s3',
        AUTH,
      );
      expect(JSON.parse(pollRes.body)).toEqual({
        has_new: true,
        reply: 'late reply',
      });
    });
  });

  // -- POST /api/watch/message audio --

  describe('POST /api/watch/message (audio)', () => {
    it('transcribes audio, calls onMessage with the transcript, returns sync reply', async () => {
      mockTranscribe.mockResolvedValue('transcribed text');

      const audioBuf = Buffer.alloc(1024, 0);
      const pending = makeRequest(
        getPort(channel),
        'POST',
        '/api/watch/message',
        { ...AUTH, 'Content-Type': 'audio/wav', 'X-Device-Id': 'twatch-s3' },
        audioBuf,
      );

      // Give the handler time to transcribe + inject
      await new Promise((r) => setTimeout(r, 30));
      expect(mockTranscribe).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      const mockCalls = (
        opts.onMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const [, msg] = mockCalls[0] as [string, { content: string }];
      expect(msg.content).toBe('transcribed text');

      await channel.sendMessage('watch:test', 'voice reply');
      const res = await pending;
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ reply: 'voice reply' });
    });

    it('returns a safe reply when transcription fails', async () => {
      mockTranscribe.mockRejectedValue(new Error('whisper broken'));

      const audioBuf = Buffer.alloc(1024, 0);
      const res = await makeRequest(
        getPort(channel),
        'POST',
        '/api/watch/message',
        { ...AUTH, 'Content-Type': 'audio/wav', 'X-Device-Id': 'twatch-s3' },
        audioBuf,
      );
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as { reply: string };
      expect(body.reply.toLowerCase()).toContain('transcribe');
      // onMessage should NOT have been called since there's no text
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // -- GET /api/watch/poll --

  describe('GET /api/watch/poll', () => {
    it('returns has_new: false on an empty queue', async () => {
      const res = await makeRequest(
        getPort(channel),
        'GET',
        '/api/watch/poll?device_id=twatch-s3',
        AUTH,
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ has_new: false });
    });

    it('returns queued reply and pops it off', async () => {
      // No pending resolver → goes straight to poll queue
      await channel.sendMessage('watch:test', 'queued message');
      const res1 = await makeRequest(
        getPort(channel),
        'GET',
        '/api/watch/poll?device_id=twatch-s3',
        AUTH,
      );
      expect(JSON.parse(res1.body)).toEqual({
        has_new: true,
        reply: 'queued message',
      });

      const res2 = await makeRequest(
        getPort(channel),
        'GET',
        '/api/watch/poll?device_id=twatch-s3',
        AUTH,
      );
      expect(JSON.parse(res2.body)).toEqual({ has_new: false });
    });
  });

  // -- sendMessage prefers pending sync resolvers over the poll queue --

  describe('sendMessage ordering', () => {
    it('drains pending resolvers before queuing for poll', async () => {
      // Kick off a POST that will register a pending resolver
      const pending = makeRequest(
        getPort(channel),
        'POST',
        '/api/watch/message',
        { ...AUTH, 'Content-Type': 'application/json' },
        JSON.stringify({ text: 'need an answer', device_id: 'twatch-s3' }),
      );
      await new Promise((r) => setTimeout(r, 20));

      // sendMessage should resolve the pending request, NOT land in the queue
      await channel.sendMessage('watch:test', 'sync answer');
      const res = await pending;
      expect(JSON.parse(res.body)).toEqual({ reply: 'sync answer' });

      // Poll queue should still be empty
      const pollRes = await makeRequest(
        getPort(channel),
        'GET',
        '/api/watch/poll?device_id=twatch-s3',
        AUTH,
      );
      expect(JSON.parse(pollRes.body)).toEqual({ has_new: false });
    });
  });

  // -- unknown routes --

  describe('unknown routes', () => {
    it('returns 404 for unknown paths (when authenticated)', async () => {
      const res = await makeRequest(
        getPort(channel),
        'GET',
        '/api/nonexistent',
        AUTH,
      );
      expect(res.status).toBe(404);
    });
  });
});
