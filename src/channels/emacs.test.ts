/**
 * Tests for the v2 emacs channel adapter.
 *
 * Exercises the HTTP surface (POST /api/message, GET /api/messages) and
 * the ChannelAdapter lifecycle (setup / teardown / isConnected / deliver).
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmacsAdapter } from './emacs.js';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeSetup(overrides: Partial<ChannelSetup> = {}): ChannelSetup {
  return {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
    ...overrides,
  };
}

/** Ask the OS for a free port, then immediately release it. Small race window
 * before the adapter grabs it, but sufficient for local test use. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function req(
  port: number,
  method: string,
  path: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode!, data: raw });
        }
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

describe('emacs adapter', () => {
  let adapter: ChannelAdapter;
  let port: number;

  beforeEach(async () => {
    port = await getFreePort();
    adapter = createEmacsAdapter({ port, authToken: null, platformId: 'default' });
  });

  afterEach(async () => {
    if (adapter.isConnected()) await adapter.teardown();
  });

  describe('lifecycle', () => {
    it('isConnected is false before setup', () => {
      expect(adapter.isConnected()).toBe(false);
    });

    it('isConnected is true after setup', async () => {
      await adapter.setup(makeSetup());
      expect(adapter.isConnected()).toBe(true);
    });

    it('isConnected is false after teardown', async () => {
      await adapter.setup(makeSetup());
      await adapter.teardown();
      expect(adapter.isConnected()).toBe(false);
    });

    it('teardown is a no-op before setup', async () => {
      await expect(adapter.teardown()).resolves.not.toThrow();
    });

    it('calls onMetadata after setup with channel name', async () => {
      const onMetadata = vi.fn();
      await adapter.setup(makeSetup({ onMetadata }));
      expect(onMetadata).toHaveBeenCalledWith('default', 'Emacs', false);
    });
  });

  describe('POST /api/message', () => {
    let onInbound: ChannelSetup['onInbound'] & { mock: { calls: unknown[][] } };

    beforeEach(async () => {
      onInbound = vi.fn() as unknown as typeof onInbound;
      await adapter.setup(makeSetup({ onInbound }));
    });

    it('fires onInbound with chat kind and sender metadata', async () => {
      const { status, data } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hello' }));
      expect(status).toBe(200);
      expect((data as { messageId: string }).messageId).toMatch(/^emacs-/);
      expect(onInbound).toHaveBeenCalledOnce();
      const [platformId, threadId, msg] = onInbound.mock.calls[0] as [string, string | null, { content: unknown }];
      expect(platformId).toBe('default');
      expect(threadId).toBeNull();
      expect(msg).toMatchObject({
        kind: 'chat',
        content: { text: 'hello', sender: 'Emacs', senderId: 'emacs:default' },
      });
    });

    it('returns 400 for empty text', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: '' }));
      expect(status).toBe(400);
      expect(onInbound).not.toHaveBeenCalled();
    });

    it('returns 400 for whitespace-only text', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: '   ' }));
      expect(status).toBe(400);
    });

    it('returns 400 for invalid JSON', async () => {
      const { status } = await req(port, 'POST', '/api/message', 'not-json');
      expect(status).toBe(400);
    });

    it('returns 404 for unknown paths', async () => {
      const { status } = await req(port, 'POST', '/api/unknown', JSON.stringify({ text: 'hi' }));
      expect(status).toBe(404);
    });
  });

  describe('GET /api/messages + deliver', () => {
    beforeEach(async () => {
      await adapter.setup(makeSetup());
    });

    it('returns empty buffer initially', async () => {
      const { status, data } = await req(port, 'GET', '/api/messages?since=0');
      expect(status).toBe(200);
      expect(data).toEqual({ messages: [] });
    });

    it('deliver pushes text for the poll endpoint to return', async () => {
      await adapter.deliver('default', null, { kind: 'chat', content: { text: 'reply' } });
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      const messages = (data as { messages: { text: string; timestamp: number }[] }).messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]?.text).toBe('reply');
      expect(typeof messages[0]?.timestamp).toBe('number');
    });

    it('deliver accepts plain-string content', async () => {
      await adapter.deliver('default', null, { kind: 'chat', content: 'raw text' });
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      expect((data as { messages: { text: string }[] }).messages[0]?.text).toBe('raw text');
    });

    it('deliver skips empty text silently', async () => {
      await adapter.deliver('default', null, { kind: 'chat', content: { text: '' } });
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      expect((data as { messages: unknown[] }).messages).toHaveLength(0);
    });

    it('deliver rejects unknown platformId', async () => {
      const result = await adapter.deliver('other', null, { kind: 'chat', content: { text: 'x' } });
      expect(result).toBeUndefined();
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      expect((data as { messages: unknown[] }).messages).toHaveLength(0);
    });

    it('filters out messages at or before the since cutoff', async () => {
      await adapter.deliver('default', null, { kind: 'chat', content: { text: 'old' } });
      const since = Date.now();
      await new Promise((r) => setTimeout(r, 5));
      await adapter.deliver('default', null, { kind: 'chat', content: { text: 'new' } });
      const { data } = await req(port, 'GET', `/api/messages?since=${since}`);
      const texts = (data as { messages: { text: string }[] }).messages.map((m) => m.text);
      expect(texts).not.toContain('old');
      expect(texts).toContain('new');
    });

    it('caps buffer at 200 messages, evicting the oldest', async () => {
      for (let i = 0; i < 205; i++) {
        await adapter.deliver('default', null, { kind: 'chat', content: { text: `m-${i}` } });
      }
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      const messages = (data as { messages: { text: string }[] }).messages;
      expect(messages).toHaveLength(200);
      expect(messages.map((m) => m.text)).not.toContain('m-0');
      expect(messages.map((m) => m.text)).toContain('m-5');
      expect(messages.map((m) => m.text)).toContain('m-204');
    });
  });

  describe('auth', () => {
    let authAdapter: ChannelAdapter;
    let authPort: number;

    beforeEach(async () => {
      authPort = await getFreePort();
      authAdapter = createEmacsAdapter({ port: authPort, authToken: 'secret', platformId: 'default' });
      await authAdapter.setup(makeSetup());
    });

    afterEach(async () => {
      if (authAdapter.isConnected()) await authAdapter.teardown();
    });

    it('rejects POST without Authorization header', async () => {
      const { status } = await req(authPort, 'POST', '/api/message', JSON.stringify({ text: 'hi' }));
      expect(status).toBe(401);
    });

    it('rejects POST with wrong token', async () => {
      const { status } = await req(authPort, 'POST', '/api/message', JSON.stringify({ text: 'hi' }), {
        Authorization: 'Bearer wrong',
      });
      expect(status).toBe(401);
    });

    it('accepts POST with correct Bearer token', async () => {
      const { status } = await req(authPort, 'POST', '/api/message', JSON.stringify({ text: 'hi' }), {
        Authorization: 'Bearer secret',
      });
      expect(status).toBe(200);
    });

    it('rejects GET without Authorization header', async () => {
      const { status } = await req(authPort, 'GET', '/api/messages?since=0');
      expect(status).toBe(401);
    });

    it('accepts GET with correct Bearer token', async () => {
      const { status } = await req(authPort, 'GET', '/api/messages?since=0', undefined, {
        Authorization: 'Bearer secret',
      });
      expect(status).toBe(200);
    });
  });
});
