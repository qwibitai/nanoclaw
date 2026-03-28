import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Channel } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';
import { WEB_CHANNEL_PORT } from '../config.js';
import { logger } from '../logger.js';

const JID_PREFIX = 'web:review:';

// Buffer agent responses per draft for SSE consumers
const responseBuffers = new Map<string, string[]>();

export function getPendingResponses(draftId: string): string[] {
  const buf = responseBuffers.get(draftId) || [];
  responseBuffers.set(draftId, []);
  return buf;
}

// SSE subscribers per draft
const sseClients = new Map<string, Set<http.ServerResponse>>();

export function createWebChannel(opts: ChannelOpts): Channel {
  let server: http.Server | null = null;
  const openSockets = new Set<import('net').Socket>();

  const MAX_BODY = 1024 * 1024; // 1 MB

  function handleMessage(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY && !aborted) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const parsed = JSON.parse(body) as { draftId?: string; text?: string };
        if (!parsed.draftId || !parsed.text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing draftId or text' }));
          return;
        }

        const chatJid = `${JID_PREFIX}${parsed.draftId}`;
        const msg = {
          id: randomUUID(),
          chat_jid: chatJid,
          sender: 'web-user',
          sender_name: 'Web User',
          content: parsed.text,
          timestamp: new Date().toISOString(),
          is_from_me: false,
        };

        opts.onMessage(chatJid, msg);
        opts.onChatMetadata(
          chatJid,
          msg.timestamp,
          `Review: ${parsed.draftId}`,
          'web',
          false,
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, messageId: msg.id }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  function handleSSE(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    draftId: string,
  ) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':\n\n'); // SSE comment to establish connection

    if (!sseClients.has(draftId)) sseClients.set(draftId, new Set());
    sseClients.get(draftId)!.add(res);

    // Send any buffered responses
    const pending = getPendingResponses(draftId);
    for (const text of pending) {
      res.write(`data: ${JSON.stringify({ type: 'message', text })}\n\n`);
    }

    req.on('close', () => {
      sseClients.get(draftId)?.delete(res);
    });
  }

  function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    const url = new URL(req.url || '/', `http://localhost`);

    if (req.method === 'POST' && url.pathname === '/message') {
      handleMessage(req, res);
      return;
    }

    // GET /stream/:draftId (UUID format only)
    const streamMatch = url.pathname.match(/^\/stream\/([a-f0-9-]{36})$/);
    if (req.method === 'GET' && streamMatch) {
      handleSSE(req, res, streamMatch[1]);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  }

  const channel: Channel = {
    name: 'web',

    async connect() {
      server = http.createServer(handleRequest);
      server.on('connection', (socket) => {
        openSockets.add(socket);
        socket.on('close', () => openSockets.delete(socket));
      });
      await new Promise<void>((resolve) => {
        server!.listen(WEB_CHANNEL_PORT, '127.0.0.1', () => {
          logger.info({ port: WEB_CHANNEL_PORT }, 'Web channel listening');
          resolve();
        });
      });
    },

    async sendMessage(jid: string, text: string) {
      const draftId = jid.replace(JID_PREFIX, '');

      // Push to SSE clients
      const clients = sseClients.get(draftId);
      if (clients && clients.size > 0) {
        const data = `data: ${JSON.stringify({ type: 'message', text })}\n\n`;
        for (const client of clients) {
          client.write(data);
        }
      }

      // Also buffer for clients that connect later (capped to prevent memory growth)
      if (!responseBuffers.has(draftId)) responseBuffers.set(draftId, []);
      const buf = responseBuffers.get(draftId)!;
      buf.push(text);
      if (buf.length > 50) buf.splice(0, buf.length - 50);
    },

    isConnected() {
      return server?.listening === true;
    },

    ownsJid(jid: string) {
      return jid.startsWith(JID_PREFIX);
    },

    async disconnect() {
      if (server) {
        for (const socket of openSockets) socket.destroy();
        openSockets.clear();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },
  };

  return channel;
}

// Self-register
registerChannel('web', (opts) => {
  return createWebChannel(opts);
});
