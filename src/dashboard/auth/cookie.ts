import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface CookiePayload {
  user_id: string;
  expires_at: string;
}

let _serverKey: Buffer | null = null;

export function _resetServerKeyForTest(): void {
  _serverKey = null;
}

export function resolveServerKey(): Buffer {
  if (_serverKey) return _serverKey;

  const envSecret = process.env.NANOCLAW_DASHBOARD_COOKIE_SECRET;
  if (envSecret) {
    _serverKey = Buffer.from(envSecret, 'hex');
    return _serverKey;
  }

  const secretPath = path.join(os.homedir(), '.nanoclaw', 'cookie-secret');
  try {
    const content = fs.readFileSync(secretPath, 'utf8').trim();
    _serverKey = Buffer.from(content, 'hex');
    return _serverKey;
  } catch {
    // File doesn't exist or unreadable — generate and persist.
  }

  const key = crypto.randomBytes(32);
  const keyHex = key.toString('hex');
  const dir = path.dirname(secretPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(secretPath, keyHex, { mode: 0o600 });
  _serverKey = key;
  return _serverKey;
}

export function buildSetCookie(payload: CookiePayload, serverKey: Buffer): string {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson).toString('base64');
  const hmac = crypto.createHmac('sha256', serverKey).update(payloadB64).digest('base64');
  const encoded = `${payloadB64}.${hmac}`;
  return `spawn_board=${encoded}; HttpOnly; Secure; SameSite=Strict; Max-Age=43200; Path=/dashboard`;
}

export function parseAndVerifyCookie(cookieHeader: string | null, serverKey: Buffer): CookiePayload | null {
  try {
    if (!cookieHeader) return null;

    const parts = cookieHeader.split(';').map((p) => p.trim());
    const entry = parts.find((p) => p.startsWith('spawn_board='));
    if (!entry) return null;

    const value = entry.slice('spawn_board='.length);
    const dotIdx = value.indexOf('.');
    if (dotIdx === -1) return null;

    const payloadB64 = value.slice(0, dotIdx);
    const receivedHmacB64 = value.slice(dotIdx + 1);

    const expectedHmac = crypto.createHmac('sha256', serverKey).update(payloadB64).digest('base64');

    const expected = Buffer.from(expectedHmac);
    const received = Buffer.from(receivedHmacB64);
    if (expected.length !== received.length) return null;
    if (!crypto.timingSafeEqual(expected, received)) return null;

    const payloadJson = Buffer.from(payloadB64, 'base64').toString('utf8');
    const parsed = JSON.parse(payloadJson) as CookiePayload;

    if (new Date(parsed.expires_at) <= new Date()) return null;

    return parsed;
  } catch {
    return null;
  }
}
