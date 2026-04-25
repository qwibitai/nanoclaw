import crypto from 'crypto';

import { SignJWT } from 'jose';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from 'redis';

const AUTH_WINDOW_SECONDS = 15 * 60;
const AUTH_RATE_LIMIT = 5;
const LOCKOUT_SECONDS = 15 * 60;

function getIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for') || '';
  return forwarded.split(',')[0]?.trim() || 'unknown';
}

function secretBytes(): Uint8Array {
  const secret = process.env.WEB_CHANNEL_SECRET || '';
  return new TextEncoder().encode(secret);
}

async function withRedis<T>(fn: (client: ReturnType<typeof createClient>) => Promise<T>): Promise<T> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required');
  }

  const client = createClient({ url: redisUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

function hash(input: string): Buffer {
  return crypto.createHash('sha256').update(input).digest();
}

export async function POST(req: NextRequest) {
  const ip = getIp(req);
  const secret = process.env.WEB_CHANNEL_SECRET || '';

  if (!secret || secret.length < 32) {
    return NextResponse.json(
      { error: 'Server misconfigured: WEB_CHANNEL_SECRET missing' },
      { status: 500 },
    );
  }

  let passphrase = '';
  try {
    const body = await req.json();
    passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!passphrase) {
    return NextResponse.json({ error: 'Passphrase required' }, { status: 400 });
  }

  try {
    const response = await withRedis(async (client) => {
      const lockoutKey = `nanoclaw:web:auth:lockout:${ip}`;
      const failedKey = `nanoclaw:web:auth:failed:${ip}`;
      const rateKey = `nanoclaw:web:auth:rate:${ip}:${Math.floor(Date.now() / 60000)}`;

      const isLocked = await client.get(lockoutKey);
      if (isLocked) {
        return NextResponse.json(
          { error: 'Too many failed attempts. Try again later.' },
          { status: 429 },
        );
      }

      const rateCount = await client.incr(rateKey);
      if (rateCount === 1) await client.expire(rateKey, 120);
      if (rateCount > AUTH_RATE_LIMIT) {
        return NextResponse.json(
          { error: 'Too many auth requests. Slow down.' },
          { status: 429 },
        );
      }

      const expected = hash(secret);
      const actual = hash(passphrase);

      if (!crypto.timingSafeEqual(expected, actual)) {
        const failed = await client.incr(failedKey);
        if (failed === 1) await client.expire(failedKey, AUTH_WINDOW_SECONDS);
        if (failed >= AUTH_RATE_LIMIT) {
          await client.set(lockoutKey, '1', { EX: LOCKOUT_SECONDS });
        }
        return NextResponse.json({ error: 'Invalid passphrase' }, { status: 401 });
      }

      await client.del(failedKey, lockoutKey);

      const token = await new SignJWT({ sessionId: 'main', type: 'web' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('24h')
        .sign(secretBytes());

      const success = NextResponse.json({ success: true });
      success.cookies.set('nanoclaw-session', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        maxAge: 86400,
        path: '/',
      });
      return success;
    });

    return response;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Auth failed' },
      { status: 500 },
    );
  }
}
