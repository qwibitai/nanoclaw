import crypto from 'crypto';
import http from 'http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  ASSISTANT_HAS_OWN_NUMBER: false,
  WHATSAPP_WEBHOOK_PORT: 0, // 0 = OS-assigned port for tests
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fetch globally for Cloud API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { WhatsAppChannel, WhatsAppChannelOpts } from './whatsapp.js';

// --- Helpers ---

function createTestOpts(
  overrides?: Partial<WhatsAppChannelOpts>,
): WhatsAppChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      '15551234567@s.whatsapp.net': {
        name: 'Jordan',
        folder: 'jordan',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function buildPayload(messages: object[], contacts: object[] = []) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: { contacts, messages },
          },
        ],
      },
    ],
  };
}

async function postWebhook(
  port: number,
  body: object,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/webhook/whatsapp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      resolve,
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getWebhook(
  port: number,
  params: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/webhook/whatsapp?${qs}`,
        method: 'GET',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// --- Tests ---

describe('WhatsAppChannel', () => {
  let channel: WhatsAppChannel;
  let port: number;

  beforeEach(async () => {
    // Set env vars for each test
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'test-phone-id';
    process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
    process.env.WHATSAPP_VERIFY_TOKEN = 'my-verify-token';

    mockFetch.mockResolvedValue({ ok: true, text: async () => '' });
  });

  afterEach(async () => {
    if (channel) {
      await channel.disconnect();
    }
    vi.clearAllMocks();
  });

  async function startChannel(opts?: WhatsAppChannelOpts): Promise<number> {
    channel = new WhatsAppChannel(opts ?? createTestOpts());
    await channel.connect();
    // Get the OS-assigned port
    const addr = (channel as any).server?.address();
    return typeof addr === 'object' && addr ? addr.port : 0;
  }

  // --- Connection lifecycle ---

  describe('connect / disconnect', () => {
    it('starts webhook server and sets connected', async () => {
      port = await startChannel();
      expect(channel.isConnected()).toBe(true);
      expect(port).toBeGreaterThan(0);
    });

    it('disconnects cleanly', async () => {
      await startChannel();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Webhook verification ---

  describe('GET /webhook/whatsapp (Meta verification)', () => {
    it('returns challenge on valid verify token', async () => {
      port = await startChannel();
      const result = await getWebhook(port, {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'my-verify-token',
        'hub.challenge': 'abc123',
      });
      expect(result.status).toBe(200);
      expect(result.body).toBe('abc123');
    });

    it('returns 403 on invalid verify token', async () => {
      port = await startChannel();
      const result = await getWebhook(port, {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong-token',
        'hub.challenge': 'abc123',
      });
      expect(result.status).toBe(403);
    });

    it('returns 403 when mode is not subscribe', async () => {
      port = await startChannel();
      const result = await getWebhook(port, {
        'hub.mode': 'unsubscribe',
        'hub.verify_token': 'my-verify-token',
        'hub.challenge': 'abc123',
      });
      expect(result.status).toBe(403);
    });
  });

  // --- Incoming message handling ---

  describe('POST /webhook/whatsapp (incoming messages)', () => {
    it('returns 200 immediately for all posts', async () => {
      const opts = createTestOpts();
      port = await startChannel(opts);

      const res = await postWebhook(port, {
        object: 'whatsapp_business_account',
        entry: [],
      });
      expect(res.statusCode).toBe(200);
    });

    it('delivers text message for registered contact', async () => {
      const opts = createTestOpts();
      port = await startChannel(opts);

      await postWebhook(
        port,
        buildPayload(
          [
            {
              id: 'msg-1',
              from: '15551234567',
              timestamp: '1700000000',
              type: 'text',
              text: { body: 'Hello Andy' },
            },
          ],
          [{ wa_id: '15551234567', profile: { name: 'Jordan' } }],
        ),
      );

      // Give async processing time to complete
      await new Promise((r) => setTimeout(r, 20));

      expect(opts.onMessage).toHaveBeenCalledWith(
        '15551234567@s.whatsapp.net',
        expect.objectContaining({
          id: 'msg-1',
          content: 'Hello Andy',
          sender_name: 'Jordan',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('calls onChatMetadata for all messages including unregistered', async () => {
      const opts = createTestOpts();
      port = await startChannel(opts);

      await postWebhook(
        port,
        buildPayload(
          [
            {
              id: 'msg-2',
              from: '19990000000',
              timestamp: '1700000001',
              type: 'text',
              text: { body: 'Hi' },
            },
          ],
          [{ wa_id: '19990000000', profile: { name: 'Stranger' } }],
        ),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        '19990000000@s.whatsapp.net',
        expect.any(String),
        'Stranger',
        'whatsapp',
        false,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('extracts caption from image messages', async () => {
      const opts = createTestOpts();
      port = await startChannel(opts);

      await postWebhook(
        port,
        buildPayload([
          {
            id: 'msg-3',
            from: '15551234567',
            timestamp: '1700000002',
            type: 'image',
            image: { caption: 'Look at this' },
          },
        ]),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(opts.onMessage).toHaveBeenCalledWith(
        '15551234567@s.whatsapp.net',
        expect.objectContaining({ content: 'Look at this' }),
      );
    });

    it('extracts caption from video messages', async () => {
      const opts = createTestOpts();
      port = await startChannel(opts);

      await postWebhook(
        port,
        buildPayload([
          {
            id: 'msg-4',
            from: '15551234567',
            timestamp: '1700000003',
            type: 'video',
            video: { caption: 'Watch this' },
          },
        ]),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(opts.onMessage).toHaveBeenCalledWith(
        '15551234567@s.whatsapp.net',
        expect.objectContaining({ content: 'Watch this' }),
      );
    });

    it('extracts caption from document messages', async () => {
      const opts = createTestOpts();
      port = await startChannel(opts);

      await postWebhook(
        port,
        buildPayload([
          {
            id: 'msg-5',
            from: '15551234567',
            timestamp: '1700000004',
            type: 'document',
            document: { caption: 'See doc' },
          },
        ]),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(opts.onMessage).toHaveBeenCalledWith(
        '15551234567@s.whatsapp.net',
        expect.objectContaining({ content: 'See doc' }),
      );
    });

    it('skips messages with no extractable text', async () => {
      const opts = createTestOpts();
      port = await startChannel(opts);

      await postWebhook(
        port,
        buildPayload([
          {
            id: 'msg-6',
            from: '15551234567',
            timestamp: '1700000005',
            type: 'audio',
          },
        ]),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses wa_id as sender_name when no profile name', async () => {
      const opts = createTestOpts();
      port = await startChannel(opts);

      await postWebhook(
        port,
        buildPayload(
          [
            {
              id: 'msg-7',
              from: '15551234567',
              timestamp: '1700000006',
              type: 'text',
              text: { body: 'Hi' },
            },
          ],
          // No contacts array
        ),
      );
      await new Promise((r) => setTimeout(r, 20));

      expect(opts.onMessage).toHaveBeenCalledWith(
        '15551234567@s.whatsapp.net',
        expect.objectContaining({ sender_name: '15551234567' }),
      );
    });

    it('ignores non-whatsapp_business_account objects', async () => {
      const opts = createTestOpts();
      port = await startChannel(opts);

      await postWebhook(port, { object: 'page', entry: [] });
      await new Promise((r) => setTimeout(r, 20));

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores non-message change fields (e.g. statuses)', async () => {
      const opts = createTestOpts();
      port = await startChannel(opts);

      await postWebhook(port, {
        object: 'whatsapp_business_account',
        entry: [{ id: 'x', changes: [{ field: 'statuses', value: {} }] }],
      });
      await new Promise((r) => setTimeout(r, 20));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('returns 404 for unknown paths', async () => {
      port = await startChannel();
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, path: '/other', method: 'POST' },
          resolve,
        );
        req.on('error', reject);
        req.end();
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // --- Sending messages ---

  describe('sendMessage', () => {
    it('calls Cloud API with correct payload', async () => {
      channel = new WhatsAppChannel(createTestOpts());

      await channel.sendMessage('15551234567@s.whatsapp.net', 'Hello');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/test-phone-id/messages'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.to).toBe('15551234567');
      expect(body.type).toBe('text');
      // ASSISTANT_HAS_OWN_NUMBER is false → prefixed
      expect(body.text.body).toBe('Andy: Hello');
    });

    it('strips @s.whatsapp.net suffix from phone number', async () => {
      channel = new WhatsAppChannel(createTestOpts());
      await channel.sendMessage('441234567890@s.whatsapp.net', 'Hi');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.to).toBe('441234567890');
    });

    it('throws on API error response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => '{"error":"Invalid token"}',
      });

      channel = new WhatsAppChannel(createTestOpts());
      await expect(
        channel.sendMessage('15551234567@s.whatsapp.net', 'Hi'),
      ).rejects.toThrow('WhatsApp API 401');
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns @s.whatsapp.net JIDs', () => {
      channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('15551234567@s.whatsapp.net')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      channel = new WhatsAppChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Typing indicator ---

  describe('setTyping', () => {
    it('is a no-op (Cloud API does not support typing indicators)', async () => {
      channel = new WhatsAppChannel(createTestOpts());
      // Should resolve without throwing and without calling fetch
      await expect(
        channel.setTyping('15551234567@s.whatsapp.net', true),
      ).resolves.toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  // --- Webhook signature verification ---

  describe('HMAC-SHA256 signature verification', () => {
    const APP_SECRET = 'test-app-secret';

    function signedPost(port: number, body: object, secret: string, tamper = false): Promise<http.IncomingMessage> {
      const data = JSON.stringify(body);
      const rawBody = Buffer.from(data);
      const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const signature = tamper ? `sha256=badhash` : `sha256=${hmac}`;

      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1', port, path: '/webhook/whatsapp', method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': rawBody.byteLength,
              'X-Hub-Signature-256': signature,
            },
          },
          resolve,
        );
        req.on('error', reject);
        req.write(data);
        req.end();
      });
    }

    beforeEach(() => {
      process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    });

    afterEach(() => {
      delete process.env.WHATSAPP_APP_SECRET;
    });

    it('accepts requests with valid signature', async () => {
      const opts = createTestOpts();
      port = await startChannel(opts);

      const res = await signedPost(port, { object: 'whatsapp_business_account', entry: [] }, APP_SECRET);
      expect(res.statusCode).toBe(200);
    });

    it('rejects requests with invalid signature', async () => {
      port = await startChannel();

      const res = await signedPost(port, { object: 'whatsapp_business_account', entry: [] }, APP_SECRET, true);
      expect(res.statusCode).toBe(401);
    });

    it('rejects requests with no signature header', async () => {
      port = await startChannel();

      const res = await postWebhook(port, { object: 'whatsapp_business_account', entry: [] });
      expect(res.statusCode).toBe(401);
    });

    it('allows unsigned requests when WHATSAPP_APP_SECRET is not set', async () => {
      delete process.env.WHATSAPP_APP_SECRET;
      const opts = createTestOpts();
      port = await startChannel(opts);

      const res = await postWebhook(port, { object: 'whatsapp_business_account', entry: [] });
      expect(res.statusCode).toBe(200);
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "whatsapp"', () => {
      channel = new WhatsAppChannel(createTestOpts());
      expect(channel.name).toBe('whatsapp');
    });
  });
});
