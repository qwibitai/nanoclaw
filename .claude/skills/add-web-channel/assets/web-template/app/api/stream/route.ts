export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { jwtVerify } from 'jose';
import { NextRequest } from 'next/server';
import { createClient } from 'redis';

type SessionPayload = {
  sessionId?: string;
};

function jwtSecret(): Uint8Array {
  return new TextEncoder().encode(process.env.WEB_CHANNEL_SECRET || '');
}

function sse(data: unknown, id?: string): string {
  const idLine = id ? `id: ${id}\n` : '';
  return `${idLine}data: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: NextRequest) {
  const token = req.cookies.get('nanoclaw-session')?.value;
  if (!token) return new Response('Unauthorized', { status: 401 });

  let payload: SessionPayload;
  try {
    const verified = await jwtVerify(token, jwtSecret());
    payload = verified.payload as SessionPayload;
  } catch {
    return new Response('Unauthorized', { status: 401 });
  }

  const sessionId =
    typeof payload.sessionId === 'string' ? payload.sessionId : 'main';
  const streamKey = `nanoclaw:outbound:${sessionId}`;
  const initialLastId = new URL(req.url).searchParams.get('lastId') || '$';
  const encoder = new TextEncoder();

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return new Response('Server misconfigured: REDIS_URL missing', {
      status: 500,
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const client = createClient({ url: redisUrl });
      let lastId = initialLastId;
      let aborted = false;

      const onAbort = () => {
        aborted = true;
        // Disconnect to unblock XREAD quickly.
        void client.disconnect().catch(() => undefined);
      };

      req.signal.addEventListener('abort', onAbort);

      try {
        await client.connect();
        controller.enqueue(
          encoder.encode(
            sse({ type: 'connected', sessionId, timestamp: Date.now() }),
          ),
        );

        while (!aborted) {
          const result = await client.xRead(
            [{ key: streamKey, id: lastId }],
            { BLOCK: 30000, COUNT: 100 },
          );

          if (aborted) break;

          if (!result || result.length === 0) {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
            continue;
          }

          for (const message of result[0].messages) {
            if (aborted) break;
            lastId = message.id;
            const raw = message.message;
            const timestamp = Number(raw.timestamp || Date.now());
            const payload = {
              type: raw.type || 'message',
              text: raw.text || '',
              isTyping: raw.isTyping || 'false',
              timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
            };
            controller.enqueue(encoder.encode(sse(payload, message.id)));
          }
        }
      } catch (err) {
        if (!aborted) {
          controller.error(err);
        }
      } finally {
        req.signal.removeEventListener('abort', onAbort);
        await client.disconnect().catch(() => undefined);
        if (!aborted) controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
