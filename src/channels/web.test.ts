import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';

function postJSON(port: number, path: string, body: object): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Connection: 'close' } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode!, body: raw }); }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('WebChannel', () => {
  let mod: typeof import('./web.js');
  let channel: import('../types.js').Channel;
  const TEST_PORT = 3299;
  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();

  beforeEach(async () => {
    vi.stubEnv('WEB_CHANNEL_PORT', String(TEST_PORT));
    vi.resetModules();
    mod = await import('./web.js');
    channel = mod.createWebChannel({
      onMessage,
      onChatMetadata,
      registeredGroups: () => ({}),
    })!;
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
    vi.unstubAllEnvs();
  });

  it('accepts POST /message and calls onMessage', async () => {
    const res = await postJSON(TEST_PORT, '/message', {
      draftId: 'abc-123',
      text: 'Fix the metadata',
    });
    expect(res.status).toBe(200);
    expect(onMessage).toHaveBeenCalledWith(
      'web:review:abc-123',
      expect.objectContaining({
        content: 'Fix the metadata',
        chat_jid: 'web:review:abc-123',
      }),
    );
  });

  it('rejects missing draftId', async () => {
    const res = await postJSON(TEST_PORT, '/message', { text: 'hello' });
    expect(res.status).toBe(400);
  });

  it('ownsJid returns true for web: prefixed JIDs', () => {
    expect(channel.ownsJid('web:review:abc-123')).toBe(true);
    expect(channel.ownsJid('tg:12345')).toBe(false);
  });

  it('buffers sendMessage output for SSE retrieval', async () => {
    await channel.sendMessage('web:review:abc-123', 'Agent response text');
    const pending = mod.getPendingResponses('abc-123');
    expect(pending).toContain('Agent response text');
  });
});
