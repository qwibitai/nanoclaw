import { logger } from '../shared/logger.ts';
import { buildLandingPage } from '../shared/landing.ts';
import type { StoreBackend } from './backend.ts';
import type { ActivityEvent, ChannelType } from '../shared/types.ts';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createStore(
  port: number,
  backend: StoreBackend,
): Deno.HttpServer {
  async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      // --- Landing page ---
      if (path === '/' && method === 'GET') {
        const html = buildLandingPage('Store', port);
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // --- Health ---
      if (path === '/health' && method === 'GET') {
        return json({ status: 'ok' });
      }

      // --- List sessions ---
      if (path === '/sessions' && method === 'GET') {
        return json(await backend.listSessions());
      }

      // --- Create session ---
      if (path === '/sessions' && method === 'POST') {
        const body = (await req.json()) as {
          channelType: ChannelType;
          channelId: string;
        };
        const session = await backend.createSession(
          body.channelType,
          body.channelId,
        );
        return json(session, 201);
      }

      // --- Session routes: /sessions/:id/* ---
      const sessionMatch = path.match(/^\/sessions\/([^/]+)(\/.*)?$/);
      if (sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]);
        const sub = sessionMatch[2] || '';

        // GET /sessions/:id
        if (sub === '' && method === 'GET') {
          const session = await backend.getSession(id);
          if (!session) return json({ error: 'not found' }, 404);
          return json(session);
        }

        // DELETE /sessions/:id
        if (sub === '' && method === 'DELETE') {
          await backend.deleteSession(id);
          return json({ status: 'ok' });
        }

        // PUT /sessions/:id/touch
        if (sub === '/touch' && method === 'PUT') {
          await backend.touchSession(id);
          return json({ status: 'ok' });
        }

        // GET /sessions/:id/agent-session
        if (sub === '/agent-session' && method === 'GET') {
          const agentSessionId = await backend.getAgentSession(id);
          return json({ agentSessionId });
        }

        // PUT /sessions/:id/agent-session
        if (sub === '/agent-session' && method === 'PUT') {
          const body = (await req.json()) as { agentSessionId: string };
          await backend.setAgentSession(id, body.agentSessionId);
          return json({ status: 'ok' });
        }

        // PUT /sessions/:id/jsonl — store JSONL transcript
        if (sub === '/jsonl' && method === 'PUT') {
          const content = new Uint8Array(await req.arrayBuffer());
          await backend.saveJsonl(id, content);
          return json({ status: 'ok' });
        }

        // GET /sessions/:id/jsonl — retrieve raw JSONL
        if (sub === '/jsonl' && method === 'GET') {
          const content = await backend.getJsonl(id);
          if (!content) return json({ error: 'not found' }, 404);
          return new Response(content as unknown as BodyInit, {
            headers: { 'Content-Type': 'application/x-ndjson' },
          });
        }

        // GET /sessions/:id/messages — parsed messages from JSONL
        if (sub === '/messages' && method === 'GET') {
          const messages = await backend.getMessages(id);
          return json(messages);
        }
      }

      // --- Events ---
      if (path === '/events' && method === 'GET') {
        const count = parseInt(
          url.searchParams.get('count') ?? '50',
          10,
        );
        return json(await backend.listEvents(count));
      }

      if (path === '/events' && method === 'POST') {
        const body = (await req.json()) as Omit<
          ActivityEvent,
          'id' | 'timestamp'
        >;
        const event = await backend.logEvent(body);
        return json(event, 201);
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      logger.error({ err }, 'Store request error');
      return json({ error: 'internal server error' }, 500);
    }
  }

  return Deno.serve({ port, hostname: '::' }, handler);
}
