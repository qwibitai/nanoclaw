import { logger } from '../shared/logger.ts';
import {
  APP_VERSION,
  ASSISTANT_NAME,
  OPERATOR_NAME,
  OPERATOR_SLUG,
} from '../shared/config.ts';
import * as queue from './queue.ts';
import { logEvent, getRecentEvents } from './event-log.ts';
import { loadSkills } from './skills.ts';
import { getOneCLIStatus } from '../shared/onecli.ts';

const startTime = Date.now();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  try {
    // --- Landing page ---
    if (path === '/' && req.method === 'GET') {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${ASSISTANT_NAME} — ${OPERATOR_NAME}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f4; color: #1c1917; }
    .container { text-align: center; padding: 2rem; }
    h1 { font-size: 2rem; font-weight: 700; margin: 0 0 0.5rem; }
    p { color: #78716c; margin: 0.25rem 0; }
    .badge { display: inline-block; background: #d1fae5; color: #065f46; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${ASSISTANT_NAME}</h1>
    <p>${OPERATOR_NAME}</p>
    <p style="font-size: 0.875rem; margin-top: 0.5rem;">Simtricity Nexus Agent Platform</p>
    <div class="badge">v${APP_VERSION}</div>
  </div>
</body>
</html>`;
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // --- Health ---
    if (path === '/health' && req.method === 'GET') {
      return json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // --- Public API ---
    if (path === '/api/status' && req.method === 'GET') {
      return json({
        name: ASSISTANT_NAME,
        version: APP_VERSION,
        uptime: formatUptime(Date.now() - startTime),
        operator: { name: OPERATOR_NAME, slug: OPERATOR_SLUG },
        skills: loadSkills(),
        onecli: getOneCLIStatus(),
        pendingWork: queue.getPendingCount(),
        processingWork: queue.getProcessingCount(),
      });
    }

    if (path === '/api/activity' && req.method === 'GET') {
      const count = parseInt(url.searchParams.get('count') ?? '50', 10);
      return json(getRecentEvents(count));
    }

    if (path === '/api/chat' && req.method === 'POST') {
      const body = await req.json();
      const message = body.message as string;
      const groupId = (body.groupId as string) || 'web-chat';

      if (!message) {
        return json({ error: 'message is required' }, 400);
      }

      const item = queue.enqueue(groupId, 'web-chat', message);

      logEvent({
        type: 'message_in',
        channel: 'web-chat',
        groupId,
        summary:
          message.length > 80 ? message.slice(0, 80) + '...' : message,
      });

      logger.info({ id: item.id, groupId }, 'Chat message queued');
      return json({ id: item.id, status: 'queued' });
    }

    if (path === '/api/chat/response' && req.method === 'GET') {
      const groupId = url.searchParams.get('groupId') || 'web-chat';
      const result = queue.consumeResult(groupId);

      if (!result) {
        return json({ status: 'pending' });
      }

      return json({
        status: 'complete',
        result: result.result,
        sessionId: result.sessionId,
        error: result.error,
      });
    }

    if (path === '/api/approvals' && req.method === 'GET') {
      return json([]);
    }

    // --- Worker API ---
    if (path === '/work/next' && req.method === 'GET') {
      const item = queue.dequeue();
      if (!item) {
        return json({ status: 'empty' });
      }

      logEvent({
        type: 'agent_start',
        channel: item.channel,
        groupId: item.groupId,
        summary: `Processing: ${item.prompt.slice(0, 60)}...`,
      });

      logger.info({ id: item.id, groupId: item.groupId }, 'Work dequeued');
      return json({ status: 'work', item });
    }

    if (path === '/work/complete' && req.method === 'POST') {
      const result = await req.json();
      queue.complete(result);

      const eventType =
        result.status === 'success' ? 'agent_complete' : 'agent_error';
      const summary =
        result.status === 'success'
          ? (result.result?.slice(0, 80) ?? '(empty response)') +
            (result.result?.length > 80 ? '...' : '')
          : `Error: ${result.error ?? 'unknown'}`;

      logEvent({
        type: eventType,
        channel: 'web-chat',
        groupId: result.groupId ?? 'web-chat',
        summary,
      });

      logger.info({ id: result.id, status: result.status }, 'Work completed');
      return json({ status: 'ok' });
    }

    // --- 404 ---
    return json({ error: 'not found' }, 404);
  } catch (err) {
    logger.error({ err }, 'Request handler error');
    return json({ error: 'internal server error' }, 500);
  }
}

export function createGateway(port: number): Deno.HttpServer {
  // Bind to :: (all interfaces, IPv4+IPv6) so Fly internal 6PN networking works
  return Deno.serve({ port, hostname: '::' }, handler);
}
