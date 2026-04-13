import http from 'http';
import crypto from 'crypto';

import { ASSISTANT_NAME, API_PORT, API_TIMEOUT, API_TOKEN } from '../config.js';
import { logger } from '../logger.js';
import type { Channel, NewMessage } from '../types.js';

import { registerChannel } from './registry.js';
import type { ChannelOpts } from './registry.js';

interface PendingRequest {
  res: http.ServerResponse;
  stream: boolean;
  timer: NodeJS.Timeout;
  startTime: number;
  chunks: string[];
  groupJid: string;
}

/**
 * Direct Message API channel.
 *
 * Accepts HTTP requests, routes them through the same message pipeline as
 * Telegram/Slack, and returns the agent's response synchronously (or as SSE).
 *
 * The channel dynamically "owns" a JID while an API request is in-flight,
 * intercepting the outbound sendMessage() that would normally go to the
 * group's real channel.
 */
export function createApiChannel(opts: ChannelOpts): Channel | null {
  if (!API_TOKEN) {
    logger.info('NANOCLAW_API_TOKEN not set — skipping API channel');
    return null;
  }

  let server: http.Server | null = null;
  let listening = false;
  let shuttingDown = false;

  // Keyed by groupJid — one pending request per group at a time
  const pending = new Map<string, PendingRequest>();

  // ── Helpers ──────────────────────────────────────────────────

  function jsonResponse(
    res: http.ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const MAX_BODY = 1024 * 1024; // 1 MB
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  function cleanupPending(key: string): void {
    const entry = pending.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(key);
    }
  }

  // ── Route handlers ──────────────────────────────────────────

  function handleHealth(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const groups = opts.registeredGroups();
    jsonResponse(res, 200, {
      status: 'ok',
      bot: ASSISTANT_NAME,
      registeredGroups: Object.keys(groups).length,
      pendingRequests: pending.size,
      uptime: process.uptime(),
    });
  }

  async function handleMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Auth
    const auth = req.headers['authorization'];
    if (!auth || auth !== `Bearer ${API_TOKEN}`) {
      jsonResponse(res, 401, { error: 'Unauthorized' });
      return;
    }

    // Parse body
    let body: Record<string, unknown>;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    // Validate required fields
    const { group, sender, sender_name, content, stream } = body as {
      group?: unknown;
      sender?: unknown;
      sender_name?: unknown;
      content?: unknown;
      stream?: unknown;
    };
    if (
      typeof group !== 'string' ||
      !group ||
      typeof sender !== 'string' ||
      !sender ||
      typeof sender_name !== 'string' ||
      !sender_name ||
      typeof content !== 'string' ||
      !content
    ) {
      jsonResponse(res, 400, {
        error:
          'Missing required fields: group, sender, sender_name, content must be non-empty strings',
      });
      return;
    }
    if (stream !== undefined && typeof stream !== 'boolean') {
      jsonResponse(res, 400, {
        error: 'Field "stream" must be a boolean when provided',
      });
      return;
    }

    // Look up group by folder name
    const groups = opts.registeredGroups();
    let chatJid: string | null = null;
    for (const [jid, g] of Object.entries(groups)) {
      if (g.folder === group) {
        chatJid = jid;
        break;
      }
    }
    if (!chatJid) {
      jsonResponse(res, 404, { error: `Group not found: ${group}` });
      return;
    }

    // Only one pending request per group
    if (pending.has(chatJid)) {
      jsonResponse(res, 409, {
        error: 'A request is already in progress for this group',
      });
      return;
    }

    const requestId = `req_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const wantStream = stream === true;

    // Set up timeout
    const timer = setTimeout(() => {
      const entry = pending.get(chatJid!);
      if (!entry) return;
      pending.delete(chatJid!);
      if (wantStream) {
        entry.res.write(`event: error\ndata: {"error":"timeout"}\n\n`);
        entry.res.end();
      } else {
        jsonResponse(entry.res, 408, { error: 'Request timed out' });
      }
    }, API_TIMEOUT);

    // Store pending request
    const entry: PendingRequest = {
      res,
      stream: wantStream,
      timer,
      startTime: Date.now(),
      chunks: [],
      groupJid: chatJid,
    };
    pending.set(chatJid, entry);

    // SSE headers for streaming
    if (wantStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
    }

    // Handle client disconnect
    res.on('close', () => {
      if (pending.has(chatJid!)) {
        logger.debug({ chatJid, requestId }, 'API client disconnected');
        cleanupPending(chatJid!);
      }
    });

    // Construct inbound message — prepend trigger so the agent processes it
    const timestamp = new Date().toISOString();
    const triggerContent = `@${ASSISTANT_NAME} ${content}`;

    const newMsg: NewMessage = {
      id: requestId,
      chat_jid: chatJid,
      sender: sender as string,
      sender_name: sender_name as string,
      content: triggerContent,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    logger.info(
      { requestId, chatJid, group, sender, stream: wantStream },
      'API message received',
    );

    // Deliver to the message pipeline
    opts.onMessage(chatJid, newMsg);
    opts.onChatMetadata(chatJid, timestamp, undefined, 'api', false);
  }

  // ── HTTP server ─────────────────────────────────────────────

  function requestHandler(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const url = new URL(req.url || '/', `http://localhost:${API_PORT}`);
    const pathname = url.pathname;

    if (shuttingDown) {
      jsonResponse(res, 503, { error: 'Server shutting down' });
      return;
    }

    if (pathname === '/api/v1/health' && req.method === 'GET') {
      handleHealth(req, res);
      return;
    }

    if (pathname === '/api/v1/message' && req.method === 'POST') {
      handleMessage(req, res).catch((err) => {
        logger.error({ err }, 'API message handler error');
        if (!res.headersSent) {
          jsonResponse(res, 500, { error: 'Internal server error' });
        }
      });
      return;
    }

    jsonResponse(res, 404, { error: 'Not found' });
  }

  // ── Channel interface ───────────────────────────────────────

  const channel: Channel & { port(): number } = {
    name: 'api',

    /** Actual listening port (may differ from API_PORT when 0 is used for tests). */
    port(): number {
      const addr = server?.address();
      return typeof addr === 'object' && addr ? addr.port : API_PORT;
    },

    async connect(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = http.createServer(requestHandler);
        server.listen(API_PORT, '0.0.0.0', () => {
          listening = true;
          const actualPort = channel.port();
          logger.info({ port: actualPort }, 'API channel listening');
          resolve();
        });
        server.on('error', (err) => {
          logger.error({ err }, 'API server error');
          if (!listening) reject(err);
        });
      });
    },

    async sendMessage(jid: string, text: string): Promise<void> {
      const entry = pending.get(jid);
      if (!entry) {
        // No pending API request for this JID — not our message to handle.
        // This shouldn't happen because ownsJid() would have returned false,
        // but guard anyway.
        return;
      }

      if (entry.stream) {
        // Push as SSE chunk
        entry.chunks.push(text);
        entry.res.write(
          `event: message\ndata: ${JSON.stringify({ content: text })}\n\n`,
        );
      } else {
        // Buffer chunk — sync response is sent when endMessage() is called
        entry.chunks.push(text);
      }
    },

    async endMessage(jid: string): Promise<void> {
      const entry = pending.get(jid);
      if (!entry) return;

      const elapsed = Date.now() - entry.startTime;

      if (entry.stream) {
        // Send terminal SSE event and close the stream
        entry.res.write(
          `event: done\ndata: ${JSON.stringify({ elapsed_ms: elapsed })}\n\n`,
        );
        entry.res.end();
      } else {
        // Respond with the concatenated output
        jsonResponse(entry.res, 200, {
          response: entry.chunks.join(''),
          elapsed_ms: elapsed,
        });
      }

      cleanupPending(jid);
    },

    isConnected(): boolean {
      return listening;
    },

    ownsJid(jid: string): boolean {
      // Dynamically claim JIDs that have a pending API request
      return pending.has(jid);
    },

    async disconnect(): Promise<void> {
      shuttingDown = true;

      // Drain pending requests
      for (const [key, entry] of pending) {
        clearTimeout(entry.timer);
        if (entry.stream) {
          entry.res.write(
            `event: error\ndata: {"error":"server_shutdown"}\n\n`,
          );
          entry.res.end();
        } else {
          jsonResponse(entry.res, 503, { error: 'Server shutting down' });
        }
        pending.delete(key);
      }

      return new Promise((resolve) => {
        if (server) {
          server.close(() => {
            listening = false;
            resolve();
          });
        } else {
          resolve();
        }
      });
    },
  };

  return channel;
}

// Self-register
registerChannel('api', createApiChannel);
