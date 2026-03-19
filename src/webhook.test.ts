import http from 'http';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { startWebhookServer } from './webhook-server.js';

// --- Token module tests ---
// We test tokens via the file they read/write, using a temp dir

const tmpDir = path.join(__dirname, '..', '.test-webhook-tmp');
const tokensPath = path.join(tmpDir, 'webhooks.json');

// Mock config.DATA_DIR so webhook-tokens reads/writes our temp dir
vi.mock('./config.js', () => ({
  DATA_DIR: path.join(__dirname, '..', '.test-webhook-tmp'),
}));

// Import after mock is set up
const tokens = await import('./webhook-tokens.js');

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  // Clean slate
  try { fs.unlinkSync(tokensPath); } catch { /* ok */ }
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
});

describe('webhook-tokens', () => {
  it('generates a token and validates it', () => {
    const token = tokens.generateToken('github', 'main@g.us');
    expect(token).toMatch(/^[a-f0-9-]+$/);

    const info = tokens.validateToken(token);
    expect(info).toEqual({ source: 'github', groupJid: 'main@g.us' });
  });

  it('returns null for unknown token', () => {
    expect(tokens.validateToken('nonexistent')).toBeNull();
  });

  it('loads all tokens', () => {
    tokens.generateToken('github', 'main@g.us');
    tokens.generateToken('email', 'other@g.us');

    const all = tokens.loadTokens();
    expect(Object.keys(all)).toHaveLength(2);
  });

  it('revokes a token', () => {
    const token = tokens.generateToken('github', 'main@g.us');
    expect(tokens.revokeToken(token)).toBe(true);
    expect(tokens.validateToken(token)).toBeNull();
  });

  it('returns false when revoking nonexistent token', () => {
    expect(tokens.revokeToken('nope')).toBe(false);
  });

  it('handles missing webhooks.json gracefully', () => {
    // No file exists — loadTokens should return empty
    expect(tokens.loadTokens()).toEqual({});
    expect(tokens.validateToken('anything')).toBeNull();
  });
});

// --- Webhook server tests ---

describe('webhook-server', () => {
  let server: http.Server;
  let port: number;
  const stored: Array<{ id: string; chat_jid: string; sender: string; sender_name: string; content: string }> = [];

  beforeEach(async () => {
    stored.length = 0;

    // Create a test token
    tokens.generateToken('test-source', 'group@g.us');

    // Find the token we just created
    const all = tokens.loadTokens();
    const testToken = Object.keys(all)[0];

    // Start server on a random port
    server = startWebhookServer({
      port: 0, // OS picks a free port
      storeMessage: (msg) => { stored.push(msg); },
    });

    // Wait for listen
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function getTestToken(): string {
    const all = tokens.loadTokens();
    return Object.keys(all)[0];
  }

  function request(
    method: string,
    urlPath: string,
    body?: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode!, body: data }));
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  it('accepts valid webhook POST and stores message', async () => {
    const token = getTestToken();
    const res = await request('POST', `/webhook/${token}`, JSON.stringify({ event: 'push', repo: 'foo' }));

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(stored).toHaveLength(1);
    expect(stored[0].chat_jid).toBe('group@g.us');
    expect(stored[0].sender).toBe('webhook');
    expect(stored[0].sender_name).toBe('test-source');
    expect(stored[0].content).toContain('[WEBHOOK from test-source]');
    expect(stored[0].content).toContain('"event": "push"');
  });

  it('returns 401 for invalid token', async () => {
    const res = await request('POST', '/webhook/00000000-0000-0000-0000-000000000000', '{}');
    expect(res.status).toBe(401);
  });

  it('returns 404 for bad path', async () => {
    const res = await request('POST', '/other', '{}');
    expect(res.status).toBe(404);
  });

  it('returns 405 for non-POST method', async () => {
    const token = getTestToken();
    const res = await request('GET', `/webhook/${token}`);
    expect(res.status).toBe(405);
  });

  it('returns 400 for invalid JSON', async () => {
    const token = getTestToken();
    const res = await request('POST', `/webhook/${token}`, 'not json{{{');
    expect(res.status).toBe(400);
  });

  it('accepts empty body as empty object', async () => {
    const token = getTestToken();
    const res = await request('POST', `/webhook/${token}`, '');
    expect(res.status).toBe(200);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toContain('{}');
  });

  it('deduplicates identical payloads without an event ID header', async () => {
    const token = getTestToken();
    // Use a unique payload to avoid collision with other tests that share module-level seenEventIds
    const body = JSON.stringify({ event: 'dedup-test', unique: 'payload-for-dedup-test' });

    const res1 = await request('POST', `/webhook/${token}`, body);
    expect(res1.status).toBe(200);
    expect(JSON.parse(res1.body)).toEqual({ ok: true });
    expect(stored).toHaveLength(1);

    // Same payload again — should be ignored
    const res2 = await request('POST', `/webhook/${token}`, body);
    expect(res2.status).toBe(200);
    expect(JSON.parse(res2.body)).toEqual({ ok: true, duplicate: true });
    expect(stored).toHaveLength(1); // still 1, not 2
  });

  it('deduplicates by x-github-delivery header', async () => {
    const token = getTestToken();
    const deliveryId = 'abc-123-delivery-id';

    function requestWithHeader(body: string): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1', port, path: `/webhook/${token}`, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-github-delivery': deliveryId },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode!, body: data }));
          },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });
    }

    const res1 = await requestWithHeader(JSON.stringify({ event: 'push' }));
    expect(JSON.parse(res1.body)).toEqual({ ok: true });
    expect(stored).toHaveLength(1);

    // Different body, same delivery ID — still duplicate
    const res2 = await requestWithHeader(JSON.stringify({ event: 'different' }));
    expect(JSON.parse(res2.body)).toEqual({ ok: true, duplicate: true });
    expect(stored).toHaveLength(1);
  });
});
