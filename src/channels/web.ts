import http from 'http';

import { ASSISTANT_NAME, MAIN_GROUP_FOLDER, WEB_CHANNEL_PORT } from '../config.js';
import { getConversationHistory } from '../db.js';
import { logger } from '../logger.js';
import { Channel, ChannelOpts } from '../types.js';

const WEB_JID = 'web:ui';
const RESPONSE_TIMEOUT_MS = 180_000; // 3 minutes
const HEARTBEAT_INTERVAL_MS = 2_000;

// ---------------------------------------------------------------------------
// SSE chunk format (matches the UI's expected protocol)
// ---------------------------------------------------------------------------

interface StreamChunk {
  type: 'thinking' | 'delta' | 'done' | 'error';
  text?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Pending response — bridges sendMessage() to the HTTP response
// ---------------------------------------------------------------------------

interface PendingResponse {
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Web Channel
// ---------------------------------------------------------------------------

export class WebChannel implements Channel {
  name = 'web';

  private server: http.Server | null = null;
  private connected = false;
  private opts: ChannelOpts;
  private pending = new Map<string, PendingResponse>();

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.opts.registerGroup(WEB_JID, {
      name: 'Web UI',
      folder: MAIN_GROUP_FOLDER,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve) => {
      this.server!.listen(WEB_CHANNEL_PORT, () => {
        logger.info({ port: WEB_CHANNEL_PORT }, 'Web channel HTTP server started');
        resolve();
      });
    });

    this.connected = true;
    logger.info('Web channel connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const entry = this.pending.get(jid);
    if (!entry) {
      logger.warn({ jid }, 'No pending web request for JID');
      return;
    }
    entry.resolve(text);
    clearTimeout(entry.timer);
    this.pending.delete(jid);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  // -------------------------------------------------------------------------
  // HTTP request router
  // -------------------------------------------------------------------------

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      this.handleHealth(res);
    } else if (req.method === 'GET' && url.pathname === '/history') {
      this.handleHistory(url, res);
    } else if (req.method === 'POST' && url.pathname === '/message') {
      this.handleMessage(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  // -------------------------------------------------------------------------
  // GET /health
  // -------------------------------------------------------------------------

  private handleHealth(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', channel: 'web', connected: this.connected }));
  }

  // -------------------------------------------------------------------------
  // GET /history
  // -------------------------------------------------------------------------

  private handleHistory(url: URL, res: http.ServerResponse): void {
    const limit = parseInt(url.searchParams.get('limit') || '200', 10);
    try {
      const messages = getConversationHistory(WEB_JID, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages }));
    } catch (err) {
      logger.error({ err }, 'Failed to fetch conversation history');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch history' }));
    }
  }

  // -------------------------------------------------------------------------
  // POST /message — accept user message, stream agent response via SSE
  // -------------------------------------------------------------------------

  private handleMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
    });

    req.on('end', () => {
      let parsed: { message: string; sender_name?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      if (!parsed.message?.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message is required' }));
        return;
      }

      // Start SSE response
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const enqueue = (chunk: StreamChunk) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      };

      // Heartbeat while the agent thinks
      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        enqueue({ type: 'thinking' });
      }, HEARTBEAT_INTERVAL_MS);

      // Promise that resolves when sendMessage() is called
      const responsePromise = new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(WEB_JID);
          clearInterval(heartbeat);
          enqueue({ type: 'error', message: 'Agent did not respond within timeout' });
          enqueue({ type: 'done' });
          res.end();
        }, RESPONSE_TIMEOUT_MS);

        this.pending.set(WEB_JID, { resolve, timer });
      });

      // Clean up if client disconnects
      res.on('close', () => {
        clearInterval(heartbeat);
        const entry = this.pending.get(WEB_JID);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(WEB_JID);
        }
      });

      // Deliver user message to the orchestrator
      const timestamp = new Date().toISOString();
      this.opts.onChatMetadata(WEB_JID, timestamp, 'Web UI', 'web', false);
      this.opts.onMessage(WEB_JID, {
        id: `web-${Date.now()}`,
        chat_jid: WEB_JID,
        sender: 'web:user',
        sender_name: parsed.sender_name || 'User',
        content: parsed.message.trim(),
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });

      // Send the agent's response when it arrives
      responsePromise.then((text) => {
        clearInterval(heartbeat);
        if (!res.writableEnded) {
          enqueue({ type: 'delta', text });
          enqueue({ type: 'done' });
          res.end();
        }
      });
    });
  }
}
