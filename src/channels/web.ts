/**
 * Web Channel — Socket.IO chat widget channel
 * Receives inbound messages from website chat widgets, sends outbound via Socket.IO.
 * JID format: web:{business} (e.g., web:snak-group)
 *
 * Widget connects with { business: 'snak-group' } in handshake query.
 * Each socket is mapped to a session ID for reply routing.
 */
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

import { Server as SocketIOServer, Socket } from 'socket.io';

import {
  ASSISTANT_NAME,
  WEB_CHANNEL_PORT,
  WEB_CHANNEL_ORIGINS,
} from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import {
  handleSquareCheckout,
  getAvailabilityBusySlots,
  handleSquareWebhook,
} from '../square-payments.js';

export interface WebChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WebChannel implements Channel {
  name = 'web';

  private server: http.Server | null = null;
  private io: SocketIOServer | null = null;
  private connected = false;
  private opts: WebChannelOpts;

  /**
   * Track active sockets by JID so we can send replies.
   * Key: web:{business}, Value: Map<sessionId, Socket>
   */
  private socketsByJid = new Map<string, Map<string, Socket>>();

  /**
   * Track the most recent session per JID for reply routing.
   */
  private lastSessionByJid = new Map<string, string>();

  constructor(opts: WebChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const widgetDir = path.resolve(process.cwd(), 'widget');

    this.server = http.createServer(async (req, res) => {
      const corsHeaders: Record<string, string> = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };

      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://localhost:${WEB_CHANNEL_PORT}`);

      // ── POST /api/checkout — Square payment + calendar + emails ──
      if (req.method === 'POST' && url.pathname === '/api/checkout') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk; });
        req.on('end', async () => {
          try {
            const payload = JSON.parse(body);
            const result = await handleSquareCheckout(payload);
            const status = result.success ? 200 : 400;
            res.writeHead(status, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Checkout endpoint error');
            res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Internal server error' }));
          }
        });
        return;
      }

      // ── POST /api/availability — return busy slots for calendar widget ──
      if (req.method === 'POST' && url.pathname === '/api/availability') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk; });
        req.on('end', async () => {
          try {
            const { equipment, startDate, endDate } = JSON.parse(body);
            if (!equipment || !startDate || !endDate) {
              res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing equipment, startDate, or endDate' }));
              return;
            }
            const busySlots = await getAvailabilityBusySlots(equipment, startDate, endDate);
            res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ busySlots }));
          } catch (err) {
            logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Availability endpoint error');
            res.writeHead(500, { ...corsHeaders, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        });
        return;
      }

      // ── POST /api/square-webhook — Square payment.completed callback ──
      if (req.method === 'POST' && url.pathname === '/api/square-webhook') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk; });
        req.on('end', async () => {
          try {
            const signature = (req.headers['x-square-hmacsha256-signature'] as string) || '';
            const ok = await handleSquareWebhook(body, signature);
            res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: ok }));
          } catch (err) {
            logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Square webhook endpoint error');
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: false }));
          }
        });
        return;
      }

      // Serve static widget files
      if (req.method === 'GET' && req.url) {
        const url = new URL(req.url, `http://localhost:${WEB_CHANNEL_PORT}`);
        const urlPath = url.pathname === '/' ? '/index.html' : url.pathname;
        // Strip /widget/ prefix since widgetDir already points to the widget folder
        const filePath = urlPath.startsWith('/widget/') ? urlPath.slice(7) : urlPath;
        const fullPath = path.join(widgetDir, filePath);

        // Prevent path traversal
        if (!fullPath.startsWith(widgetDir)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const ext = path.extname(fullPath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
          };
          res.writeHead(200, {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*',
          });
          fs.createReadStream(fullPath).pipe(res);
          return;
        }
      }

      res.writeHead(200);
      res.end('ok');
    });

    this.io = new SocketIOServer(this.server, {
      cors: {
        origin: WEB_CHANNEL_ORIGINS.length > 0 ? WEB_CHANNEL_ORIGINS : '*',
        methods: ['GET', 'POST'],
      },
      serveClient: true,
    });

    this.io.on('connection', (socket) => this.handleConnection(socket));

    await new Promise<void>((resolve) => {
      this.server!.listen(WEB_CHANNEL_PORT, () => {
        this.connected = true;
        logger.info(
          { port: WEB_CHANNEL_PORT, origins: WEB_CHANNEL_ORIGINS },
          'Web channel listening',
        );
        resolve();
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const sessionId = this.lastSessionByJid.get(jid);
    if (!sessionId) {
      logger.warn({ jid }, 'No active web session for reply');
      return;
    }

    const socketsForJid = this.socketsByJid.get(jid);
    const socket = socketsForJid?.get(sessionId);
    if (!socket || !socket.connected) {
      logger.warn({ jid, sessionId }, 'Web socket disconnected, cannot reply');
      return;
    }

    socket.emit('message', {
      sender: ASSISTANT_NAME,
      text,
      timestamp: new Date().toISOString(),
    });

    logger.info(
      { jid, sessionId, length: text.length },
      'Web message sent',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.io) {
      this.io.close();
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const sessionId = this.lastSessionByJid.get(jid);
    if (!sessionId) return;

    const socketsForJid = this.socketsByJid.get(jid);
    const socket = socketsForJid?.get(sessionId);
    if (!socket || !socket.connected) return;

    socket.emit('typing', { isTyping });
  }

  // ── Connection handler ──────────────────────────────────────────

  private handleConnection(socket: Socket): void {
    const business =
      (socket.handshake.query.business as string) || 'default';
    const jid = `web:${business}`;
    const sessionId =
      (socket.handshake.query.sessionId as string) ||
      crypto.randomUUID();

    logger.info({ jid, sessionId }, 'Web client connected');

    // Track socket
    if (!this.socketsByJid.has(jid)) {
      this.socketsByJid.set(jid, new Map());
    }
    this.socketsByJid.get(jid)!.set(sessionId, socket);
    this.lastSessionByJid.set(jid, sessionId);

    // Send session ID back to client
    socket.emit('session', { sessionId });

    // Update chat metadata
    this.opts.onChatMetadata(jid, new Date().toISOString(), `Web: ${business}`);

    socket.on('message', (data: { text?: string; history?: string }) => {
      const text = data?.text?.trim();
      if (!text) return;

      // Only deliver to registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) {
        logger.warn({ jid }, 'Web message for unregistered group, ignoring');
        return;
      }

      this.lastSessionByJid.set(jid, sessionId);

      const msgId = `web-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

      // If this is an escalation with FAQ history, prepend it
      let content = text;
      if (data.history) {
        content = `[FAQ conversation history]\n${data.history}\n[End FAQ history]\n\n${text}`;
      }

      const newMsg: NewMessage = {
        id: msgId,
        chat_jid: jid,
        sender: `visitor:${sessionId.slice(0, 8)}`,
        sender_name: 'Website Visitor',
        content,
        timestamp: new Date().toISOString(),
        is_from_me: false,
        is_bot_message: false,
      };

      this.opts.onMessage(jid, newMsg);
    });

    socket.on('disconnect', () => {
      logger.info({ jid, sessionId }, 'Web client disconnected');
      const socketsForJid = this.socketsByJid.get(jid);
      if (socketsForJid) {
        socketsForJid.delete(sessionId);
        if (socketsForJid.size === 0) {
          this.socketsByJid.delete(jid);
        }
      }
    });
  }
}
