import http from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { WhatsAppCloudChannel } from './whatsapp-cloud.js';
import { NewMessage } from '../types.js';

function makeChannel(overrides: Partial<ConstructorParameters<typeof WhatsAppCloudChannel>[0]> = {}) {
  return new WhatsAppCloudChannel({
    phoneNumberId: 'test-phone-id',
    accessToken: 'test-token',
    verifyToken: 'test-verify',
    port: 0, // random port
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
    ...overrides,
  });
}

function request(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: body ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('WhatsAppCloudChannel', () => {
  let channel: WhatsAppCloudChannel;
  let port: number;

  beforeEach(async () => {
    channel = makeChannel();
    await channel.connect();
    // Extract the port from the listening server
    const addr = (channel as any).server.address();
    port = addr.port;
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  describe('webhook verification', () => {
    it('returns challenge on valid verify token', async () => {
      const res = await request(
        port,
        'GET',
        '/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=test-challenge-123',
      );
      expect(res.status).toBe(200);
      expect(res.body).toBe('test-challenge-123');
    });

    it('returns 403 on invalid verify token', async () => {
      const res = await request(
        port,
        'GET',
        '/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=test',
      );
      expect(res.status).toBe(403);
    });

    it('returns 403 when mode is not subscribe', async () => {
      const res = await request(
        port,
        'GET',
        '/webhook?hub.mode=unsubscribe&hub.verify_token=test-verify&hub.challenge=test',
      );
      expect(res.status).toBe(403);
    });
  });

  describe('webhook message handling', () => {
    it('calls onMessage for valid text messages', async () => {
      const onMessage = vi.fn();
      await channel.disconnect();
      channel = makeChannel({
        onMessage,
        registeredGroups: () => ({
          'wa:31612345678': {
            name: 'Test',
            folder: 'test',
            trigger: '@Bot',
            added_at: new Date().toISOString(),
          },
        }),
      });
      await channel.connect();
      port = ((channel as any).server.address()).port;

      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: 'msg-001',
                      from: '31612345678',
                      type: 'text',
                      timestamp: '1700000000',
                      text: { body: 'Hello bot' },
                    },
                  ],
                  contacts: [
                    { wa_id: '31612345678', profile: { name: 'Test User' } },
                  ],
                },
              },
            ],
          },
        ],
      };

      const res = await request(port, 'POST', '/webhook', JSON.stringify(payload));
      expect(res.status).toBe(200);

      // Give async handler time to process
      await new Promise((r) => setTimeout(r, 50));

      expect(onMessage).toHaveBeenCalledTimes(1);
      const [jid, msg] = onMessage.mock.calls[0] as [string, NewMessage];
      expect(jid).toBe('wa:31612345678');
      expect(msg.content).toBe('Hello bot');
      expect(msg.sender_name).toBe('Test User');
      expect(msg.chat_jid).toBe('wa:31612345678');
    });

    it('deduplicates messages by ID', async () => {
      const onMessage = vi.fn();
      await channel.disconnect();
      channel = makeChannel({
        onMessage,
        registeredGroups: () => ({
          'wa:31612345678': {
            name: 'Test',
            folder: 'test',
            trigger: '@Bot',
            added_at: new Date().toISOString(),
          },
        }),
      });
      await channel.connect();
      port = ((channel as any).server.address()).port;

      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      id: 'msg-dup',
                      from: '31612345678',
                      type: 'text',
                      timestamp: '1700000000',
                      text: { body: 'Duplicate' },
                    },
                  ],
                  contacts: [],
                },
              },
            ],
          },
        ],
      };

      await request(port, 'POST', '/webhook', JSON.stringify(payload));
      await new Promise((r) => setTimeout(r, 50));
      await request(port, 'POST', '/webhook', JSON.stringify(payload));
      await new Promise((r) => setTimeout(r, 50));

      expect(onMessage).toHaveBeenCalledTimes(1);
    });

    it('skips non-text messages', async () => {
      const onMessage = vi.fn();
      await channel.disconnect();
      channel = makeChannel({
        onMessage,
        registeredGroups: () => ({
          'wa:31612345678': {
            name: 'Test',
            folder: 'test',
            trigger: '@Bot',
            added_at: new Date().toISOString(),
          },
        }),
      });
      await channel.connect();
      port = ((channel as any).server.address()).port;

      const payload = {
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    { id: 'msg-img', from: '31612345678', type: 'image', timestamp: '1700000000' },
                  ],
                  contacts: [],
                },
              },
            ],
          },
        ],
      };

      await request(port, 'POST', '/webhook', JSON.stringify(payload));
      await new Promise((r) => setTimeout(r, 50));

      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  describe('ownsJid', () => {
    it('returns true for wa: prefix', () => {
      expect(channel.ownsJid('wa:31612345678')).toBe(true);
    });

    it('returns false for other prefixes', () => {
      expect(channel.ownsJid('tg:12345')).toBe(false);
      expect(channel.ownsJid('31612345678')).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('returns true after connect', () => {
      expect(channel.isConnected()).toBe(true);
    });

    it('returns false after disconnect', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('non-webhook paths', () => {
    it('returns 404 for unknown paths', async () => {
      const res = await request(port, 'GET', '/other');
      expect(res.status).toBe(404);
    });

    it('returns 405 for unsupported methods on /webhook', async () => {
      const res = await request(port, 'PUT', '/webhook');
      expect(res.status).toBe(405);
    });
  });
});
