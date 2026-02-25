import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  MAIN_GROUP_FOLDER: 'main',
  WEB_CHANNEL_PORT: 0, // random port for tests
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  getConversationHistory: vi.fn(() => [
    {
      id: 'msg-1',
      content: 'Hello',
      sender_name: 'User',
      timestamp: '2025-01-01T00:00:00.000Z',
      is_bot_message: 0,
    },
    {
      id: 'msg-2',
      content: 'Hi there!',
      sender_name: 'Andy',
      timestamp: '2025-01-01T00:00:01.000Z',
      is_bot_message: 1,
    },
  ]),
}));

import { WebChannel } from './web.js';
import { ChannelOpts } from '../types.js';

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    registerGroup: vi.fn(),
    ...overrides,
  };
}

/** Get the server's actual port after it starts listening on port 0. */
function getPort(channel: WebChannel): number {
  // Access the private server field
  const server = (channel as any).server;
  const addr = server?.address();
  return typeof addr === 'object' ? addr.port : 0;
}

function buildUrl(channel: WebChannel, path: string): string {
  return `http://127.0.0.1:${getPort(channel)}${path}`;
}

describe('WebChannel', () => {
  let channel: WebChannel;
  let opts: ChannelOpts;

  beforeEach(async () => {
    vi.clearAllMocks();
    opts = createTestOpts();
    channel = new WebChannel(opts);
  });

  afterEach(async () => {
    if (channel.isConnected()) {
      await channel.disconnect();
    }
  });

  describe('channel properties', () => {
    it('has name "web"', () => {
      expect(channel.name).toBe('web');
    });
  });

  describe('ownsJid', () => {
    it('owns web: prefixed JIDs', () => {
      expect(channel.ownsJid('web:ui')).toBe(true);
      expect(channel.ownsJid('web:other')).toBe(true);
    });

    it('does not own other JID formats', () => {
      expect(channel.ownsJid('cli:console')).toBe(false);
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:12345')).toBe(false);
      expect(channel.ownsJid('dc:12345')).toBe(false);
    });
  });

  describe('connect', () => {
    it('registers as main group with requiresTrigger false', async () => {
      await channel.connect();

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'web:ui',
        expect.objectContaining({
          name: 'Web UI',
          folder: 'main',
          requiresTrigger: false,
        }),
      );
    });

    it('sets connected to true', async () => {
      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('starts HTTP server', async () => {
      await channel.connect();
      const port = getPort(channel);
      expect(port).toBeGreaterThan(0);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false and stops HTTP server', async () => {
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('GET /health', () => {
    it('returns status ok', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/health'));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({
        status: 'ok',
        channel: 'web',
        connected: true,
      });
    });
  });

  describe('GET /history', () => {
    it('returns conversation history', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/history'));
      const body = (await res.json()) as { messages: Array<{ content: string }> };

      expect(res.status).toBe(200);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].content).toBe('Hello');
      expect(body.messages[1].content).toBe('Hi there!');
    });
  });

  describe('POST /message', () => {
    it('rejects empty message', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects invalid JSON', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });

      expect(res.status).toBe(400);
    });

    it('delivers message to orchestrator and streams response', async () => {
      await channel.connect();

      // Simulate the orchestrator calling sendMessage after receiving the message
      opts.onMessage = vi.fn(() => {
        // Simulate async agent response
        setTimeout(() => {
          channel.sendMessage('web:ui', 'Hello from the agent!');
        }, 50);
      });

      const res = await fetch(buildUrl(channel, '/message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello', sender_name: 'Test User' }),
      });

      const text = await res.text();
      const chunks = text
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.replace('data: ', '')));

      // Should have at least a delta and done chunk
      const deltaChunk = chunks.find((c: any) => c.type === 'delta');
      const doneChunk = chunks.find((c: any) => c.type === 'done');

      expect(deltaChunk).toBeDefined();
      expect(deltaChunk.text).toBe('Hello from the agent!');
      expect(doneChunk).toBeDefined();

      // Verify onChatMetadata was called
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'web:ui',
        expect.any(String),
        'Web UI',
        'web',
        false,
      );
    });

    it('uses default sender_name when not provided', async () => {
      await channel.connect();

      opts.onMessage = vi.fn((_jid, msg) => {
        expect(msg.sender_name).toBe('User');
        setTimeout(() => channel.sendMessage('web:ui', 'ok'), 10);
      });

      const res = await fetch(buildUrl(channel, '/message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test' }),
      });

      await res.text(); // consume the response
    });
  });

  describe('sendMessage', () => {
    it('logs warning when no pending request exists', async () => {
      const { logger } = await import('../logger.js');
      await channel.connect();
      await channel.sendMessage('web:ui', 'orphan message');
      expect(logger.warn).toHaveBeenCalledWith(
        { jid: 'web:ui' },
        'No pending web request for JID',
      );
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/unknown'));
      expect(res.status).toBe(404);
    });
  });

  describe('CORS', () => {
    it('handles OPTIONS preflight', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/health'), {
        method: 'OPTIONS',
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  });
});
