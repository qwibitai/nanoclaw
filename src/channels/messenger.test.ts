import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import crypto from 'crypto';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  FB_APP_SECRET: 'test-app-secret',
  FB_MESSENGER_PORT: 0, // Use random port to avoid conflicts
  FB_PAGE_ACCESS_TOKEN: 'test-page-access-token',
  FB_PAGE_ID: 'PAGE_ID_123',
  FB_VERIFY_TOKEN: 'test-verify-token',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  audit: vi.fn(),
}));

vi.mock('../db.js', () => ({
  getLastSender: vi.fn(() => null),
  upsertContactFromPhone: vi.fn(),
}));

vi.mock('../pipeline/stages/webhook-guard.js', () => ({
  isWebhookRateLimited: vi.fn(() => false),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { MessengerChannel, MessengerChannelOpts } from './messenger.js';
import { getLastSender, upsertContactFromPhone } from '../db.js';
import { isWebhookRateLimited } from '../pipeline/stages/webhook-guard.js';
import http from 'http';

// --- Helpers ---

function createTestOpts(
  overrides?: Partial<MessengerChannelOpts>,
): MessengerChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'messenger:sheridan': {
        name: 'Sheridan Messenger',
        folder: 'sheridan-messenger',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function computeSignature(body: string, secret = 'test-app-secret'): string {
  return (
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  );
}

function makeMessagingPayload(
  senderId: string,
  text: string,
  messageId = 'mid.test123',
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    object: 'page',
    entry: [
      {
        messaging: [
          {
            sender: { id: senderId },
            recipient: { id: 'PAGE_ID_123' },
            timestamp: Date.now(),
            message: { mid: messageId, text, ...extra },
          },
        ],
      },
    ],
  });
}

/** Send an HTTP request to the channel's server */
function sendRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () =>
          resolve({ statusCode: res.statusCode!, body: data, headers: res.headers }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- Tests ---

describe('MessengerChannel', () => {
  let channel: MessengerChannel;
  let port: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('{}') });
  });

  afterEach(async () => {
    if (channel?.isConnected()) {
      await channel.disconnect();
    }
  });

  async function connectChannel(opts?: Partial<MessengerChannelOpts>): Promise<void> {
    channel = new MessengerChannel(createTestOpts(opts));
    await channel.connect();
    // Grab the actual port the server is listening on
    const addr = (channel as any).server.address();
    port = addr.port;
  }

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('returns true for messenger: prefixed JIDs', () => {
      const ch = new MessengerChannel(createTestOpts());
      expect(ch.ownsJid('messenger:sheridan')).toBe(true);
      expect(ch.ownsJid('messenger:anything')).toBe(true);
    });

    it('returns false for non-messenger JIDs', () => {
      const ch = new MessengerChannel(createTestOpts());
      expect(ch.ownsJid('whatsapp:123')).toBe(false);
      expect(ch.ownsJid('tg:123')).toBe(false);
      expect(ch.ownsJid('12345@g.us')).toBe(false);
      expect(ch.ownsJid('random-string')).toBe(false);
    });
  });

  // --- isConnected ---

  describe('isConnected', () => {
    it('returns false before connect()', () => {
      const ch = new MessengerChannel(createTestOpts());
      expect(ch.isConnected()).toBe(false);
    });

    it('returns true after connect()', async () => {
      await connectChannel();
      expect(channel.isConnected()).toBe(true);
    });

    it('returns false after disconnect()', async () => {
      await connectChannel();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Webhook signature verification ---

  describe('webhook signature verification', () => {
    it('accepts requests with valid HMAC signature', async () => {
      await connectChannel();
      const body = makeMessagingPayload('USER_1', 'Hello');
      const sig = computeSignature(body);

      const res = await sendRequest(port, 'POST', '/webhook/messenger', body, {
        'x-hub-signature-256': sig,
      });

      expect(res.statusCode).toBe(200);
    });

    it('rejects requests with invalid signature', async () => {
      await connectChannel();
      const body = makeMessagingPayload('USER_1', 'Hello');

      const res = await sendRequest(port, 'POST', '/webhook/messenger', body, {
        'x-hub-signature-256': 'sha256=invalid',
      });

      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('invalid signature');
    });

    it('rejects requests with no signature', async () => {
      await connectChannel();
      const body = makeMessagingPayload('USER_1', 'Hello');

      const res = await sendRequest(port, 'POST', '/webhook/messenger', body);

      expect(res.statusCode).toBe(401);
    });

    it('rejects when signature length differs (timingSafeEqual safety)', async () => {
      await connectChannel();
      const body = makeMessagingPayload('USER_1', 'Hello');

      const res = await sendRequest(port, 'POST', '/webhook/messenger', body, {
        'x-hub-signature-256': 'sha256=short',
      });

      // timingSafeEqual throws on length mismatch, caught and returns false → 401
      expect(res.statusCode).toBe(401);
    });
  });

  // --- Webhook verification (GET) ---

  describe('webhook verification (GET)', () => {
    it('responds with challenge on valid verification request', async () => {
      await connectChannel();

      const res = await sendRequest(
        port,
        'GET',
        '/webhook/messenger?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=CHALLENGE_123',
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe('CHALLENGE_123');
    });

    it('rejects verification with wrong token', async () => {
      await connectChannel();

      const res = await sendRequest(
        port,
        'GET',
        '/webhook/messenger?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=CHALLENGE_123',
      );

      expect(res.statusCode).toBe(403);
    });

    it('rejects verification with wrong mode', async () => {
      await connectChannel();

      const res = await sendRequest(
        port,
        'GET',
        '/webhook/messenger?hub.mode=unsubscribe&hub.verify_token=test-verify-token&hub.challenge=CHALLENGE_123',
      );

      expect(res.statusCode).toBe(403);
    });
  });

  // --- Echo filtering ---

  describe('echo filtering', () => {
    it('skips messages with is_echo flag', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      const payload = JSON.stringify({
        object: 'page',
        entry: [
          {
            messaging: [
              {
                sender: { id: 'USER_1' },
                recipient: { id: 'PAGE_ID_123' },
                timestamp: Date.now(),
                message: { mid: 'mid.echo1', text: 'Echo message', is_echo: true },
              },
            ],
          },
        ],
      });
      const sig = computeSignature(payload);

      await sendRequest(port, 'POST', '/webhook/messenger', payload, {
        'x-hub-signature-256': sig,
      });

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips messages from the page itself (FB_PAGE_ID)', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      const payload = makeMessagingPayload('PAGE_ID_123', 'From page');
      const sig = computeSignature(payload);

      await sendRequest(port, 'POST', '/webhook/messenger', payload, {
        'x-hub-signature-256': sig,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Inbound message processing ---

  describe('inbound message processing', () => {
    it('delivers valid inbound messages to onMessage callback', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      const payload = makeMessagingPayload('USER_42', 'Is this still available?');
      const sig = computeSignature(payload);

      await sendRequest(port, 'POST', '/webhook/messenger', payload, {
        'x-hub-signature-256': sig,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'messenger:sheridan',
        expect.objectContaining({
          id: 'mid.test123',
          chat_jid: 'messenger:sheridan',
          sender: 'fb:USER_42',
          sender_name: 'Facebook User',
          content: 'Is this still available?',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('calls onChatMetadata with JID and timestamp', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      const payload = makeMessagingPayload('USER_42', 'Hello');
      const sig = computeSignature(payload);

      await sendRequest(port, 'POST', '/webhook/messenger', payload, {
        'x-hub-signature-256': sig,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'messenger:sheridan',
        expect.any(String),
        'Facebook Messenger',
      );
    });

    it('drops messages for unregistered JIDs', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})), // No registered groups
      });
      await connectChannel(opts);

      const payload = makeMessagingPayload('USER_42', 'Hello');
      const sig = computeSignature(payload);

      await sendRequest(port, 'POST', '/webhook/messenger', payload, {
        'x-hub-signature-256': sig,
      });

      await new Promise((r) => setTimeout(r, 50));

      // onChatMetadata still fires, but onMessage should not
      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('upserts CRM contact on inbound message', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      const payload = makeMessagingPayload('USER_42', 'Contact me');
      const sig = computeSignature(payload);

      await sendRequest(port, 'POST', '/webhook/messenger', payload, {
        'x-hub-signature-256': sig,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(upsertContactFromPhone).toHaveBeenCalledWith(
        'fb:USER_42',
        'facebook_messenger',
        ['facebook', 'messenger'],
      );
    });

    it('respects shouldProcess filter', async () => {
      const opts = createTestOpts({
        shouldProcess: vi.fn(() => false),
      });
      await connectChannel(opts);

      const payload = makeMessagingPayload('USER_42', 'Blocked');
      const sig = computeSignature(payload);

      await sendRequest(port, 'POST', '/webhook/messenger', payload, {
        'x-hub-signature-256': sig,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(opts.shouldProcess).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores non-page payloads', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      const payload = JSON.stringify({ object: 'not-page', entry: [] });
      const sig = computeSignature(payload);

      await sendRequest(port, 'POST', '/webhook/messenger', payload, {
        'x-hub-signature-256': sig,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores messaging events without text (e.g., delivery receipts)', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      const payload = JSON.stringify({
        object: 'page',
        entry: [
          {
            messaging: [
              {
                sender: { id: 'USER_42' },
                recipient: { id: 'PAGE_ID_123' },
                delivery: { mids: ['mid.123'], watermark: 123 },
              },
            ],
          },
        ],
      });
      const sig = computeSignature(payload);

      await sendRequest(port, 'POST', '/webhook/messenger', payload, {
        'x-hub-signature-256': sig,
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('calls Facebook Graph API with correct parameters', async () => {
      await connectChannel();

      // Set up a known sender so reply routing works
      (channel as any).lastSenderByJid.set('messenger:sheridan', 'USER_42');

      await channel.sendMessage('messenger:sheridan', 'Hello from bot');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://graph.facebook.com/v21.0/me/messages',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-page-access-token',
          }),
          body: expect.any(String),
        }),
      );

      // Verify the body content
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.recipient).toEqual({ id: 'USER_42' });
      expect(callBody.message.text).toBe('Andy: Hello from bot');
      expect(callBody.messaging_type).toBe('RESPONSE');
    });

    it('falls back to DB for recipient lookup', async () => {
      vi.mocked(getLastSender).mockReturnValue('fb:USER_DB');
      await connectChannel();

      await channel.sendMessage('messenger:sheridan', 'Hello');

      expect(getLastSender).toHaveBeenCalledWith('messenger:sheridan');
      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.recipient).toEqual({ id: 'USER_DB' });
    });

    it('warns and skips when no recipient known', async () => {
      vi.mocked(getLastSender).mockReturnValue(null);
      await connectChannel();

      await channel.sendMessage('messenger:unknown', 'Hello');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('tracks sender after inbound message for reply routing', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      // Send an inbound message to set up sender tracking
      const payload = makeMessagingPayload('USER_99', 'Hi');
      const sig = computeSignature(payload);

      await sendRequest(port, 'POST', '/webhook/messenger', payload, {
        'x-hub-signature-256': sig,
      });

      await new Promise((r) => setTimeout(r, 50));

      // Now send a reply — should route to USER_99
      await channel.sendMessage('messenger:sheridan', 'Reply');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.recipient).toEqual({ id: 'USER_99' });
    });
  });

  // --- Message prefixing ---

  describe('message prefixing', () => {
    it('prepends ASSISTANT_NAME to outgoing messages', async () => {
      await connectChannel();
      (channel as any).lastSenderByJid.set('messenger:sheridan', 'USER_42');

      await channel.sendMessage('messenger:sheridan', 'Test message');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.message.text).toBe('Andy: Test message');
    });
  });

  // --- Message splitting ---

  describe('message splitting', () => {
    it('does not split messages under 2000 chars', async () => {
      await connectChannel();
      (channel as any).lastSenderByJid.set('messenger:sheridan', 'USER_42');

      const shortMsg = 'A'.repeat(100);
      await channel.sendMessage('messenger:sheridan', shortMsg);

      // Only one call — the prefixed message is under 2000
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('splits messages over 2000 chars into multiple chunks', async () => {
      await connectChannel();
      (channel as any).lastSenderByJid.set('messenger:sheridan', 'USER_42');

      // Create a message that with prefix will exceed 2000 chars
      // "Andy: " is 6 chars prefix, so we need > 1994 chars of content
      const longMsg = 'word '.repeat(500); // ~2500 chars
      await channel.sendMessage('messenger:sheridan', longMsg);

      // Should be split into multiple API calls
      expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    });

    it('splits at word boundaries when possible', async () => {
      await connectChannel();

      // Access the private method directly for precise testing
      const chunks = (channel as any).splitMessage('A'.repeat(1000) + ' ' + 'B'.repeat(1000) + ' ' + 'C'.repeat(500), 2000);

      // First chunk should be roughly 2000 chars, split at a space
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBeLessThanOrEqual(2000);
      expect(chunks[1].length).toBeLessThanOrEqual(2000);
    });

    it('hard splits when no good break point exists', async () => {
      await connectChannel();

      // A single word with no spaces or newlines
      const noBreaks = 'X'.repeat(3000);
      const chunks = (channel as any).splitMessage(noBreaks, 2000);

      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBe(2000);
      expect(chunks[1].length).toBe(1000);
    });

    it('prefers newline splits over space splits', async () => {
      await connectChannel();

      // 1500 chars, then newline, then 1000 chars
      const text = 'A'.repeat(1500) + '\n' + 'B'.repeat(1000);
      const chunks = (channel as any).splitMessage(text, 2000);

      expect(chunks.length).toBe(2);
      expect(chunks[0]).toBe('A'.repeat(1500));
      expect(chunks[1]).toBe('B'.repeat(1000));
    });
  });

  // --- Circuit breaker ---

  describe('circuit breaker', () => {
    it('skips send when circuit breaker is open', async () => {
      await connectChannel();
      (channel as any).lastSenderByJid.set('messenger:sheridan', 'USER_42');

      // Force the circuit breaker to open state with a recent failure
      const breaker = (channel as any).graphBreaker;
      breaker._state = 'open';
      breaker.lastFailureAt = Date.now();
      breaker.failures = 10;

      await channel.sendMessage('messenger:sheridan', 'Should be skipped');

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sends through when circuit breaker is closed', async () => {
      await connectChannel();
      (channel as any).lastSenderByJid.set('messenger:sheridan', 'USER_42');

      const breaker = (channel as any).graphBreaker;
      expect(breaker.state).toBe('closed');

      await channel.sendMessage('messenger:sheridan', 'Should send');

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('handles send errors without throwing', async () => {
      await connectChannel();
      (channel as any).lastSenderByJid.set('messenger:sheridan', 'USER_42');

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      // Should not throw despite API error
      await expect(
        channel.sendMessage('messenger:sheridan', 'Will fail'),
      ).resolves.toBeUndefined();
    });
  });

  // --- Rate limiting ---

  describe('rate limiting', () => {
    it('returns 429 when webhook is rate limited', async () => {
      vi.mocked(isWebhookRateLimited).mockReturnValue(true);
      await connectChannel();

      const payload = makeMessagingPayload('USER_42', 'Hello');
      const sig = computeSignature(payload);

      const res = await sendRequest(port, 'POST', '/webhook/messenger', payload, {
        'x-hub-signature-256': sig,
      });

      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('60');
    });
  });

  // --- Health check ---

  describe('health check', () => {
    it('responds to /health endpoint', async () => {
      vi.mocked(isWebhookRateLimited).mockReturnValue(false);
      await connectChannel();

      const res = await sendRequest(port, 'GET', '/health');

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
      expect(body.channel).toBe('messenger');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "messenger"', () => {
      const ch = new MessengerChannel(createTestOpts());
      expect(ch.name).toBe('messenger');
    });
  });
});
