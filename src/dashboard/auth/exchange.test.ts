import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// Mock cookie.js to use a stable test key and avoid filesystem writes
vi.mock('./cookie.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./cookie.js')>();
  const testKey = Buffer.from('a'.repeat(64), 'hex');
  return {
    ...orig,
    resolveServerKey: vi.fn(() => testKey),
    buildSetCookie: orig.buildSetCookie,
  };
});

// Mock router.js register to avoid side-effect route table pollution
vi.mock('../router.js', () => ({
  register: vi.fn(),
}));

import crypto from 'crypto';
import { closeDb, initTestDb, runMigrations, getDb } from '../../db/index.js';
import { issueDashboardToken, consumeDashboardToken } from '../db/dashboard-tokens.js';
import { exchangeHandler } from './exchange.js';
import { resolveServerKey } from './cookie.js';
import http from 'http';

function makeNodeCtx() {
  return {
    rawNodeReq: {} as http.IncomingMessage,
  };
}

function makeReq(body: unknown, overrides: { origin?: string; host?: string } = {}): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    host: overrides.host ?? 'localhost:3000',
  };
  if (overrides.origin !== undefined) headers['origin'] = overrides.origin;
  return new Request('http://localhost:3000/dashboard/api/auth/exchange', {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function hmacToken(rawToken: string): string {
  const key = resolveServerKey();
  return crypto.createHmac('sha256', key).update(rawToken).digest('hex');
}

function issueRawToken(userId: string): string {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHmac = hmacToken(rawToken);
  issueDashboardToken(userId, tokenHmac, 24);
  return rawToken;
}

function insertUser(id: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'test', NULL, ?)")
    .run(id, new Date().toISOString());
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
});

describe('exchangeHandler', () => {
  it('test_exchange_valid_token_sets_cookie', async () => {
    insertUser('u1');
    const rawToken = issueRawToken('u1');

    const req = makeReq({ token: rawToken });
    const res = await exchangeHandler(req, {}, makeNodeCtx());

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const body = (await res!.json()) as { user_id: string; expires_at: string };
    expect(body.user_id).toBe('u1');
    expect(body.expires_at).toBeTruthy();

    const setCookie = res!.headers.get('set-cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toMatch(/^spawn_board=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
  });

  it('test_exchange_invalid_token_returns_400', async () => {
    const req = makeReq({ token: 'gibberish-token-that-does-not-exist' });
    const res = await exchangeHandler(req, {}, makeNodeCtx());

    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe('invalid_token');
    expect(res!.headers.get('set-cookie')).toBeNull();
  });

  it('test_exchange_used_token_returns_400', async () => {
    insertUser('u1');
    const rawToken = issueRawToken('u1');
    const hmac = hmacToken(rawToken);

    // Consume it once
    consumeDashboardToken(hmac);

    // Try again with same token
    const req = makeReq({ token: rawToken });
    const res = await exchangeHandler(req, {}, makeNodeCtx());

    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe('invalid_token');
  });

  it('test_exchange_expired_token_returns_400', async () => {
    insertUser('u1');
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHmac = hmacToken(rawToken);

    // Insert with past expires_at
    getDb()
      .prepare(
        `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at)
         VALUES (?, ?, datetime('now', '-2 hours'), datetime('now', '-1 hour'))`,
      )
      .run('u1', tokenHmac);

    const req = makeReq({ token: rawToken });
    const res = await exchangeHandler(req, {}, makeNodeCtx());

    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe('invalid_token');
  });

  it('test_exchange_no_body_returns_400', async () => {
    const req = new Request('http://localhost:3000/dashboard/api/auth/exchange', {
      method: 'POST',
      headers: { host: 'localhost:3000' },
    });
    const res = await exchangeHandler(req, {}, makeNodeCtx());

    expect(res!.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('test_exchange_no_csrf_origin_check', async () => {
    insertUser('u1');
    const rawToken = issueRawToken('u1');

    const req = makeReq({ token: rawToken }, { origin: 'https://evil.com', host: 'localhost:3000' });
    const res = await exchangeHandler(req, {}, makeNodeCtx());

    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toBe('origin_mismatch');
  });
});
