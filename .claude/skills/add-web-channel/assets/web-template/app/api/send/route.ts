import { jwtVerify } from 'jose';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from 'redis';

const SEND_RATE_LIMIT = 10;

type SessionPayload = {
  sessionId?: string;
};

function jwtSecret(): Uint8Array {
  return new TextEncoder().encode(process.env.WEB_CHANNEL_SECRET || '');
}

async function withRedis<T>(
  fn: (client: ReturnType<typeof createClient>) => Promise<T>,
): Promise<T> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required');

  const client = createClient({ url: redisUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

function parseMessageId(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) return '';
  return trimmed;
}

export async function POST(req: NextRequest) {
  const token = req.cookies.get('nanoclaw-session')?.value;
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: SessionPayload;
  try {
    const verified = await jwtVerify(token, jwtSecret());
    payload = verified.payload as SessionPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  const sessionId =
    typeof payload.sessionId === 'string' ? payload.sessionId : 'main';

  let body: { text?: unknown; messageId?: unknown };
  try {
    body = (await req.json()) as { text?: unknown; messageId?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const messageId = parseMessageId(body.messageId);
  if (!text || text.length > 10000 || !messageId) {
    return NextResponse.json({ error: 'Invalid message' }, { status: 400 });
  }

  try {
    await withRedis(async (client) => {
      const rateKey = `nanoclaw:web:send:rate:${sessionId}:${Math.floor(Date.now() / 60000)}`;
      const count = await client.incr(rateKey);
      if (count === 1) await client.expire(rateKey, 120);
      if (count > SEND_RATE_LIMIT) {
        throw new Error('RATE_LIMITED');
      }

      await client.lPush(
        'nanoclaw:inbound',
        JSON.stringify({
          sessionId: 'main',
          text,
          userName: 'Web User',
          messageId,
          timestamp: Date.now(),
        }),
      );
    });
  } catch (err) {
    if (err instanceof Error && err.message === 'RATE_LIMITED') {
      return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Send failed' },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true });
}
