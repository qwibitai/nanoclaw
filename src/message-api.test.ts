import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';

import { _initTestDatabase, _setMigrationsDir } from './db/index.js';
import {
  getOutboundMessage,
  insertOutboundMessage,
  countRecentMessages,
} from './db/index.js';
import {
  renderTemplate,
  startMessageApi,
  stopMessageApi,
  _validateRequest,
} from './message-api.js';

import path from 'path';
const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

let nextPort = 14000;
function getPort(): number {
  return nextPort++;
}

function makeRequest(
  port: number,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ statusCode: res.statusCode!, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('message-api', () => {
  beforeEach(() => {
    _setMigrationsDir(MIGRATIONS_DIR);
    _initTestDatabase();
  });

  describe('renderTemplate', () => {
    it('renders alert template', () => {
      const result = renderTemplate('alert', 'Server down');
      expect(result).toContain('Alert');
      expect(result).toContain('Server down');
    });

    it('renders digest template', () => {
      const result = renderTemplate('digest', 'Daily summary');
      expect(result).toContain('Digest');
      expect(result).toContain('Daily summary');
    });

    it('renders notification template', () => {
      const result = renderTemplate('notification', 'New event');
      expect(result).toContain('New event');
    });

    it('renders custom template as-is', () => {
      const result = renderTemplate('custom', 'Hello world');
      expect(result).toBe('Hello world');
    });
  });

  describe('validateRequest', () => {
    it('rejects non-object body', () => {
      const result = _validateRequest('string');
      expect(result.ok).toBe(false);
    });

    it('rejects missing recipient', () => {
      const result = _validateRequest({ content: 'hello' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('recipient');
    });

    it('rejects missing content', () => {
      const result = _validateRequest({ recipient: 'tg:123' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('content');
    });

    it('rejects invalid template', () => {
      const result = _validateRequest({
        recipient: 'tg:123',
        content: 'hello',
        template: 'invalid',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('template');
    });

    it('rejects invalid priority', () => {
      const result = _validateRequest({
        recipient: 'tg:123',
        content: 'hello',
        priority: 'urgent',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('priority');
    });

    it('rejects invalid scheduled_for', () => {
      const result = _validateRequest({
        recipient: 'tg:123',
        content: 'hello',
        scheduled_for: 'not-a-date',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('scheduled_for');
    });

    it('accepts valid minimal request', () => {
      const result = _validateRequest({
        recipient: 'tg:123',
        content: 'hello',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.recipient).toBe('tg:123');
        expect(result.data.content).toBe('hello');
        expect(result.data.template).toBe('custom');
        expect(result.data.priority).toBe('normal');
      }
    });

    it('accepts full request with all fields', () => {
      const result = _validateRequest({
        recipient: 'tg:123',
        content: 'hello',
        template: 'alert',
        priority: 'critical',
        scheduled_for: '2025-06-01T00:00:00Z',
        batch_key: 'batch-1',
        batch_window: 60000,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.template).toBe('alert');
        expect(result.data.priority).toBe('critical');
        expect(result.data.batch_key).toBe('batch-1');
      }
    });
  });

  describe('HTTP server', () => {
    let testPort: number;

    const mockChannel = {
      name: 'test',
      connect: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      isConnected: () => true,
      ownsJid: (jid: string) => jid.startsWith('tg:'),
      disconnect: vi.fn(),
    };

    beforeEach(async () => {
      testPort = getPort();
      mockChannel.sendMessage.mockClear();
      await startMessageApi(() => [mockChannel], testPort);
    });

    afterEach(async () => {
      await stopMessageApi();
    });

    it('POST /api/v1/messages returns 201 with message ID', async () => {
      const res = await makeRequest(testPort, 'POST', '/api/v1/messages', {
        recipient: 'tg:12345',
        content: 'Hello from API',
      });

      expect(res.statusCode).toBe(201);
      const body = res.body as { id: string; status: string };
      expect(body.id).toBeDefined();
      expect(body.status).toBe('pending');
    });

    it('POST /api/v1/messages with alert template delivers formatted message', async () => {
      const res = await makeRequest(testPort, 'POST', '/api/v1/messages', {
        recipient: 'tg:12345',
        content: 'Server is down',
        template: 'alert',
      });

      expect(res.statusCode).toBe(201);

      // Wait for async delivery
      await new Promise((r) => setTimeout(r, 200));

      expect(mockChannel.sendMessage).toHaveBeenCalledWith(
        'tg:12345',
        expect.stringContaining('Alert'),
      );
    });

    it('POST /api/v1/messages returns 400 for missing content', async () => {
      const res = await makeRequest(testPort, 'POST', '/api/v1/messages', {
        recipient: 'tg:12345',
      });

      expect(res.statusCode).toBe(400);
      const body = res.body as { error: string };
      expect(body.error).toContain('content');
    });

    it('POST /api/v1/messages returns 400 for invalid JSON', async () => {
      const res = await new Promise<{ statusCode: number; body: unknown }>(
        (resolve, reject) => {
          const req = http.request(
            {
              hostname: '127.0.0.1',
              port: testPort,
              path: '/api/v1/messages',
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            },
            (resp) => {
              const chunks: Buffer[] = [];
              resp.on('data', (chunk) => chunks.push(chunk));
              resp.on('end', () => {
                resolve({
                  statusCode: resp.statusCode!,
                  body: JSON.parse(Buffer.concat(chunks).toString()),
                });
              });
            },
          );
          req.on('error', reject);
          req.write('not json');
          req.end();
        },
      );

      expect(res.statusCode).toBe(400);
    });

    it('POST /api/v1/messages with batch_key returns batched status', async () => {
      const res = await makeRequest(testPort, 'POST', '/api/v1/messages', {
        recipient: 'tg:12345',
        content: 'Batched message',
        batch_key: 'test-batch',
      });

      expect(res.statusCode).toBe(201);
      const body = res.body as {
        id: string;
        status: string;
        batch_key: string;
      };
      expect(body.status).toBe('batched');
      expect(body.batch_key).toBe('test-batch');
    });

    it('POST /api/v1/messages with scheduled_for stores for later', async () => {
      const future = new Date(Date.now() + 3600000).toISOString();
      const res = await makeRequest(testPort, 'POST', '/api/v1/messages', {
        recipient: 'tg:12345',
        content: 'Scheduled message',
        scheduled_for: future,
      });

      expect(res.statusCode).toBe(201);
      const body = res.body as {
        id: string;
        status: string;
        scheduled_for: string;
      };
      expect(body.status).toBe('pending');
      expect(body.scheduled_for).toBe(future);
    });

    it('GET /api/v1/messages/:id returns message status', async () => {
      const postRes = await makeRequest(testPort, 'POST', '/api/v1/messages', {
        recipient: 'tg:12345',
        content: 'Check status',
      });

      const postBody = postRes.body as { id: string };
      const getRes = await makeRequest(
        testPort,
        'GET',
        `/api/v1/messages/${postBody.id}`,
      );

      expect(getRes.statusCode).toBe(200);
      const getBody = getRes.body as { id: string; recipient_id: string };
      expect(getBody.id).toBe(postBody.id);
      expect(getBody.recipient_id).toBe('tg:12345');
    });

    it('GET /api/v1/messages/:id returns 404 for unknown ID', async () => {
      const res = await makeRequest(
        testPort,
        'GET',
        '/api/v1/messages/unknown-id',
      );

      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for unknown routes', async () => {
      const res = await makeRequest(testPort, 'GET', '/not-found');
      expect(res.statusCode).toBe(404);
    });

    it('delivers messages with channel sendMessage', async () => {
      await makeRequest(testPort, 'POST', '/api/v1/messages', {
        recipient: 'tg:12345',
        content: 'Direct delivery',
      });

      // Wait for async delivery
      await new Promise((r) => setTimeout(r, 200));

      expect(mockChannel.sendMessage).toHaveBeenCalledWith(
        'tg:12345',
        'Direct delivery',
      );
    });

    it('fails delivery when no channel matches recipient', async () => {
      const res = await makeRequest(testPort, 'POST', '/api/v1/messages', {
        recipient: 'unknown:999',
        content: 'Will fail',
      });

      expect(res.statusCode).toBe(201); // Accepted, delivery is async

      // Wait for async delivery attempt (includes retry backoff)
      await new Promise((r) => setTimeout(r, 1500));

      const body = res.body as { id: string };
      const msg = getOutboundMessage(body.id);
      expect(msg?.status).toBe('failed');
    });
  });

  describe('database operations', () => {
    it('insertOutboundMessage and getOutboundMessage round-trip', () => {
      const now = new Date().toISOString();
      insertOutboundMessage({
        id: 'test-1',
        recipient_id: 'tg:123',
        recipient_type: 'channel_jid',
        template: 'alert',
        content: 'Test message',
        priority: 'high',
        status: 'pending',
        scheduled_for: null,
        batch_key: null,
        batch_window: 300000,
        created_at: now,
      });

      const msg = getOutboundMessage('test-1');
      expect(msg).toBeDefined();
      expect(msg!.recipient_id).toBe('tg:123');
      expect(msg!.template).toBe('alert');
      expect(msg!.priority).toBe('high');
      expect(msg!.status).toBe('pending');
      expect(msg!.retry_count).toBe(0);
    });

    it('countRecentMessages counts within window', () => {
      const now = new Date().toISOString();
      for (let i = 0; i < 5; i++) {
        insertOutboundMessage({
          id: `count-${i}`,
          recipient_id: 'tg:456',
          recipient_type: 'channel_jid',
          template: 'custom',
          content: `Message ${i}`,
          priority: 'normal',
          status: 'sent',
          scheduled_for: null,
          batch_key: null,
          batch_window: 300000,
          created_at: now,
        });
      }

      const count = countRecentMessages('tg:456', 60000);
      expect(count).toBe(5);

      // Different recipient should return 0
      const otherCount = countRecentMessages('tg:999', 60000);
      expect(otherCount).toBe(0);
    });
  });
});
