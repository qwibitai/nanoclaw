import http from 'http';
import { logger } from '../shared/logger.js';
import {
  APP_VERSION,
  ASSISTANT_NAME,
  OPERATOR_NAME,
  OPERATOR_SLUG,
} from '../shared/config.js';
import * as queue from './queue.js';
import { logEvent, getRecentEvents } from './event-log.js';
import { loadSkills } from './skills.js';

const startTime = Date.now();

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
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

export function createGateway(port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    // CORS for console dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url!, `http://${req.headers.host}`);
    const path = url.pathname;

    try {
      // --- Health ---
      if (path === '/health' && req.method === 'GET') {
        return json(res, { status: 'ok', timestamp: new Date().toISOString() });
      }

      // --- Public API ---
      if (path === '/api/status' && req.method === 'GET') {
        return json(res, {
          name: ASSISTANT_NAME,
          version: APP_VERSION,
          uptime: formatUptime(Date.now() - startTime),
          operator: { name: OPERATOR_NAME, slug: OPERATOR_SLUG },
          skills: loadSkills(),
          pendingWork: queue.getPendingCount(),
          processingWork: queue.getProcessingCount(),
        });
      }

      if (path === '/api/activity' && req.method === 'GET') {
        const count = parseInt(url.searchParams.get('count') ?? '50', 10);
        return json(res, getRecentEvents(count));
      }

      if (path === '/api/chat' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const message = body.message as string;
        const groupId = (body.groupId as string) || 'web-chat';

        if (!message) {
          return json(res, { error: 'message is required' }, 400);
        }

        const item = queue.enqueue(groupId, 'web-chat', message);

        logEvent({
          type: 'message_in',
          channel: 'web-chat',
          groupId,
          summary: message.length > 80 ? message.slice(0, 80) + '...' : message,
        });

        logger.info({ id: item.id, groupId }, 'Chat message queued');
        return json(res, { id: item.id, status: 'queued' });
      }

      if (path === '/api/chat/response' && req.method === 'GET') {
        const groupId = url.searchParams.get('groupId') || 'web-chat';
        const result = queue.consumeResult(groupId);

        if (!result) {
          return json(res, { status: 'pending' });
        }

        return json(res, {
          status: 'complete',
          result: result.result,
          sessionId: result.sessionId,
          error: result.error,
        });
      }

      if (path === '/api/approvals' && req.method === 'GET') {
        return json(res, []);
      }

      // --- Worker API ---
      if (path === '/work/next' && req.method === 'GET') {
        const item = queue.dequeue();
        if (!item) {
          return json(res, { status: 'empty' });
        }

        logEvent({
          type: 'agent_start',
          channel: item.channel,
          groupId: item.groupId,
          summary: `Processing: ${item.prompt.slice(0, 60)}...`,
        });

        logger.info({ id: item.id, groupId: item.groupId }, 'Work dequeued');
        return json(res, { status: 'work', item });
      }

      if (path === '/work/complete' && req.method === 'POST') {
        const result = JSON.parse(await readBody(req));
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
        return json(res, { status: 'ok' });
      }

      // --- 404 ---
      json(res, { error: 'not found' }, 404);
    } catch (err) {
      logger.error({ err }, 'Request handler error');
      json(res, { error: 'internal server error' }, 500);
    }
  });

  return server;
}
