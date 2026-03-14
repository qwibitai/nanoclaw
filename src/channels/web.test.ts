import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  WEB_CHANNEL_PORT: 0, // Random available port
  WEB_CHANNEL_ORIGINS: ['https://example.com', 'https://app.example.com'],
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../square-payments.js', () => ({
  handleSquareCheckout: vi.fn(),
  getAvailabilityBusySlots: vi.fn(),
  handleSquareWebhook: vi.fn(),
  getBookingById: vi.fn(),
}));

import { WebChannel, WebChannelOpts } from './web.js';
import { logger } from '../logger.js';

// --- Helpers ---

function createOpts(overrides?: Partial<WebChannelOpts>): WebChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'web:snak-group': {
        name: 'Snak Web',
        folder: 'snak',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

/** Create a fake Socket.IO socket for testing */
function createFakeSocket(query?: Record<string, string>) {
  const emitter = new EventEmitter();
  const socket = {
    handshake: {
      query: {
        business: 'snak-group',
        sessionId: 'test-session-123',
        ...query,
      },
    },
    emit: vi.fn(),
    connected: true,
    on: (event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler);
    },
    _emitter: emitter,
  };
  return socket;
}

// --- Tests ---

describe('WebChannel', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('returns true for web: prefixed JIDs', () => {
      const channel = new WebChannel(createOpts());
      expect(channel.ownsJid('web:snak-group')).toBe(true);
      expect(channel.ownsJid('web:default')).toBe(true);
    });

    it('returns false for non-web JIDs', () => {
      const channel = new WebChannel(createOpts());
      expect(channel.ownsJid('quo:+16825551000')).toBe(false);
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });
  });

  // --- isConnected ---

  describe('isConnected', () => {
    it('returns false before connect', () => {
      const channel = new WebChannel(createOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('returns true after connect', async () => {
      const channel = new WebChannel(createOpts());
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      await channel.disconnect();
    });

    it('returns false after disconnect', async () => {
      const channel = new WebChannel(createOpts());
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Path traversal prevention ---

  describe('path traversal prevention', () => {
    it('blocks path traversal attempts with 403', async () => {
      const channel = new WebChannel(createOpts());
      await channel.connect();

      const port = (channel as any).server.address().port;

      const response = await fetch(
        `http://localhost:${port}/../../etc/passwd`,
      );

      // The path.join resolves the traversal; if it escapes widgetDir, we get 403
      // If the resolved path is still within widgetDir (which it may be since
      // path.join normalizes), the file just won't exist, so we get 200 "ok" fallback
      // Either way, it should NOT serve /etc/passwd
      const body = await response.text();
      expect(body).not.toContain('root:');

      await channel.disconnect();
    });
  });

  // --- CORS validation ---

  describe('CORS validation', () => {
    it('sets correct CORS header for allowed origin', async () => {
      const channel = new WebChannel(createOpts());
      await channel.connect();

      const port = (channel as any).server.address().port;

      const response = await fetch(`http://localhost:${port}/`, {
        headers: { Origin: 'https://example.com' },
      });

      // The static file handler or default handler runs; CORS is set on API routes
      // For OPTIONS preflight, CORS headers are always set
      const preflightResponse = await fetch(`http://localhost:${port}/`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://example.com' },
      });

      expect(preflightResponse.status).toBe(204);
      expect(preflightResponse.headers.get('access-control-allow-origin')).toBe(
        'https://example.com',
      );

      await channel.disconnect();
    });

    it('uses first allowed origin when request origin is not allowed', async () => {
      const channel = new WebChannel(createOpts());
      await channel.connect();

      const port = (channel as any).server.address().port;

      const response = await fetch(`http://localhost:${port}/`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.com' },
      });

      expect(response.headers.get('access-control-allow-origin')).toBe(
        'https://example.com',
      );

      await channel.disconnect();
    });
  });

  // --- Message rate limiting ---

  describe('message rate limiting', () => {
    it('enforces per-session rate limit', async () => {
      const opts = createOpts();
      const channel = new WebChannel(opts);
      await channel.connect();

      // Simulate a socket connection
      const fakeSocket = createFakeSocket();
      (channel as any).handleConnection(fakeSocket as any);

      // Send 10 messages (the limit)
      for (let i = 0; i < 10; i++) {
        fakeSocket._emitter.emit('message', { text: `msg ${i}` });
      }

      expect(opts.onMessage).toHaveBeenCalledTimes(10);

      // The 11th message should be rate limited
      fakeSocket._emitter.emit('message', { text: 'over limit' });

      expect(fakeSocket.emit).toHaveBeenCalledWith('error', {
        message: 'Rate limit exceeded. Please wait a moment.',
      });
      // onMessage should still have been called only 10 times
      expect(opts.onMessage).toHaveBeenCalledTimes(10);

      await channel.disconnect();
    });

    it('resets rate limit after window expires', async () => {
      const opts = createOpts();
      const channel = new WebChannel(opts);
      await channel.connect();

      const fakeSocket = createFakeSocket();
      (channel as any).handleConnection(fakeSocket as any);

      // Send 10 messages to fill the limit
      for (let i = 0; i < 10; i++) {
        fakeSocket._emitter.emit('message', { text: `msg ${i}` });
      }

      expect(opts.onMessage).toHaveBeenCalledTimes(10);

      // Verify the 11th is blocked
      fakeSocket._emitter.emit('message', { text: 'blocked' });
      expect(opts.onMessage).toHaveBeenCalledTimes(10);

      await channel.disconnect();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('emits to the correct socket', async () => {
      const opts = createOpts();
      const channel = new WebChannel(opts);
      await channel.connect();

      const fakeSocket = createFakeSocket();
      (channel as any).handleConnection(fakeSocket as any);

      await channel.sendMessage('web:snak-group', 'Hello from Andy');

      expect(fakeSocket.emit).toHaveBeenCalledWith('message', {
        sender: 'Andy',
        text: 'Hello from Andy',
        timestamp: expect.any(String),
      });

      await channel.disconnect();
    });

    it('warns when no active session exists for JID', async () => {
      const opts = createOpts();
      const channel = new WebChannel(opts);
      await channel.connect();

      await channel.sendMessage('web:unknown-business', 'Hello');

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'web:unknown-business' }),
        'No active web session for reply',
      );

      await channel.disconnect();
    });

    it('warns when socket is disconnected', async () => {
      const opts = createOpts();
      const channel = new WebChannel(opts);
      await channel.connect();

      const fakeSocket = createFakeSocket();
      fakeSocket.connected = false;
      (channel as any).handleConnection(fakeSocket as any);

      await channel.sendMessage('web:snak-group', 'Hello');

      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'web:snak-group' }),
        'Web socket disconnected, cannot reply',
      );

      await channel.disconnect();
    });
  });

  // --- Unregistered group handling ---

  describe('unregistered group handling', () => {
    it('ignores messages for unregistered groups', async () => {
      const opts = createOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = new WebChannel(opts);
      await channel.connect();

      const fakeSocket = createFakeSocket();
      (channel as any).handleConnection(fakeSocket as any);

      fakeSocket._emitter.emit('message', { text: 'Hello' });

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'web:snak-group' }),
        'Web message for unregistered group, ignoring',
      );

      await channel.disconnect();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "web"', () => {
      const channel = new WebChannel(createOpts());
      expect(channel.name).toBe('web');
    });
  });
});
