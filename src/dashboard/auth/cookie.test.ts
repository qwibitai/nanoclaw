import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { _resetServerKeyForTest, buildSetCookie, parseAndVerifyCookie, resolveServerKey } from './cookie.js';

function futureIso(): string {
  return new Date(Date.now() + 3600 * 1000).toISOString();
}

function pastIso(): string {
  return new Date(Date.now() - 3600 * 1000).toISOString();
}

describe('cookie sign/verify', () => {
  it('test_buildSetCookie_format', () => {
    const serverKey = crypto.randomBytes(32);
    const payload = { user_id: 'u1', expires_at: futureIso() };
    const setCookie = buildSetCookie(payload, serverKey);
    expect(setCookie).toContain('spawn_board=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure'); // default secure: true
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Max-Age=43200');
    expect(setCookie).toContain('Path=/dashboard');
  });

  it('test_buildSetCookie_omits_secure_when_explicit_false', () => {
    // Plain HTTP from non-loopback hosts: cookie must NOT include Secure or
    // browsers refuse to set it (post-merge ergonomics fix for LAN/WAN access).
    const serverKey = crypto.randomBytes(32);
    const payload = { user_id: 'u1', expires_at: futureIso() };
    const setCookie = buildSetCookie(payload, serverKey, { secure: false });
    expect(setCookie).toContain('spawn_board=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Max-Age=43200');
    expect(setCookie).toContain('Path=/dashboard');
  });

  it('test_parseAndVerifyCookie_roundtrip', () => {
    const serverKey = crypto.randomBytes(32);
    const payload = { user_id: 'u1', expires_at: futureIso() };
    const setCookie = buildSetCookie(payload, serverKey);
    const cookieValue = setCookie.split(';')[0]!;
    const result = parseAndVerifyCookie(cookieValue, serverKey);
    expect(result).not.toBeNull();
    expect(result!.user_id).toBe('u1');
    expect(result!.expires_at).toBe(payload.expires_at);
  });

  it('test_parseAndVerifyCookie_tampered_returns_null', () => {
    const serverKey = crypto.randomBytes(32);
    const payload = { user_id: 'u1', expires_at: futureIso() };
    const setCookie = buildSetCookie(payload, serverKey);
    const cookieValue = setCookie.split(';')[0]!;
    const eqIdx = cookieValue.indexOf('=');
    const dotIdx = cookieValue.indexOf('.');
    const tampered =
      cookieValue.slice(0, eqIdx + 1) +
      (cookieValue[eqIdx + 1] === 'A' ? 'B' : 'A') +
      cookieValue.slice(eqIdx + 2, dotIdx) +
      cookieValue.slice(dotIdx);
    expect(parseAndVerifyCookie(tampered, serverKey)).toBeNull();
  });

  it('test_parseAndVerifyCookie_expired_returns_null', () => {
    const serverKey = crypto.randomBytes(32);
    const payload = { user_id: 'u1', expires_at: pastIso() };
    const setCookie = buildSetCookie(payload, serverKey);
    const cookieValue = setCookie.split(';')[0]!;
    expect(parseAndVerifyCookie(cookieValue, serverKey)).toBeNull();
  });

  it('test_parseAndVerifyCookie_wrong_key_returns_null', () => {
    const k1 = crypto.randomBytes(32);
    const k2 = crypto.randomBytes(32);
    const payload = { user_id: 'u1', expires_at: futureIso() };
    const setCookie = buildSetCookie(payload, k1);
    const cookieValue = setCookie.split(';')[0]!;
    expect(parseAndVerifyCookie(cookieValue, k2)).toBeNull();
  });
});

describe('resolveServerKey', () => {
  const origEnv = process.env.NANOCLAW_DASHBOARD_COOKIE_SECRET;

  beforeEach(() => {
    _resetServerKeyForTest();
    delete process.env.NANOCLAW_DASHBOARD_COOKIE_SECRET;
  });

  afterEach(() => {
    _resetServerKeyForTest();
    if (origEnv !== undefined) {
      process.env.NANOCLAW_DASHBOARD_COOKIE_SECRET = origEnv;
    } else {
      delete process.env.NANOCLAW_DASHBOARD_COOKIE_SECRET;
    }
  });

  it('test_resolveServerKey_env_priority', () => {
    const keyHex = crypto.randomBytes(32).toString('hex');
    process.env.NANOCLAW_DASHBOARD_COOKIE_SECRET = keyHex;
    const key = resolveServerKey();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.toString('hex')).toBe(keyHex);
  });

  it('test_resolveServerKey_file_fallback', () => {
    // Write a key file to a temp location and override homedir resolution
    // by pointing HOME env var to a temp dir
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cookie-fb-'));
    try {
      const keyHex = crypto.randomBytes(32).toString('hex');
      const secretDir = path.join(tmpHome, '.nanoclaw');
      fs.mkdirSync(secretDir, { recursive: true });
      const secretPath = path.join(secretDir, 'cookie-secret');
      fs.writeFileSync(secretPath, keyHex, { mode: 0o600 });

      // Patch os.homedir for this call by temporarily overriding HOME
      const origHome = process.env.HOME;
      process.env.HOME = tmpHome;
      try {
        const key = resolveServerKey();
        expect(key).toBeInstanceOf(Buffer);
        expect(key.toString('hex')).toBe(keyHex);
      } finally {
        if (origHome !== undefined) process.env.HOME = origHome;
        else delete process.env.HOME;
      }
    } finally {
      fs.rmSync(tmpHome, { recursive: true });
    }
  });

  it('test_resolveServerKey_generates_when_missing', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-cookie-gen-'));
    try {
      const origHome = process.env.HOME;
      process.env.HOME = tmpHome;
      try {
        const key = resolveServerKey();
        expect(key).toBeInstanceOf(Buffer);
        expect(key.byteLength).toBe(32);

        const secretPath = path.join(tmpHome, '.nanoclaw', 'cookie-secret');
        expect(fs.existsSync(secretPath)).toBe(true);
        const mode = fs.statSync(secretPath).mode & 0o777;
        expect(mode).toBe(0o600);
        const stored = fs.readFileSync(secretPath, 'utf8').trim();
        expect(key.toString('hex')).toBe(stored);
      } finally {
        if (origHome !== undefined) process.env.HOME = origHome;
        else delete process.env.HOME;
      }
    } finally {
      fs.rmSync(tmpHome, { recursive: true });
    }
  });
});
