import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Channel, NewMessage, OnInboundMessage, OnChatMetadata } from '../types.js';
import { logger } from '../logger.js';
import { GROUPS_DIR, WEBSOCKET_FILES_PORT } from '../config.js';

const WS_JID = 'ws:better-work';
const MAX_BUFFER = 50;
const HEARTBEAT_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;

export interface WebSocketChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

interface BufferedMessage {
  content: string;
  timestamp: string;
}

interface InboundAttachment {
  name: string;
  data: string;   // base64
  mime: string;
  size: number;
}

export class WebSocketChannel implements Channel {
  name = 'websocket';
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private buffer: BufferedMessage[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private fileServer: http.Server | null = null;
  private readonly groupDir: string;
  private readonly filesDir: string;

  constructor(
    private readonly port: number,
    private readonly opts: WebSocketChannelOpts,
    private readonly filesPort: number = WEBSOCKET_FILES_PORT,
  ) {
    this.groupDir = path.join(GROUPS_DIR, 'better-work');
    this.filesDir = path.join(this.groupDir, 'files');
  }

  private saveInboundAttachment(att: InboundAttachment): string {
    const inboxDir = path.join(this.groupDir, 'inbox', 'attachments');
    fs.mkdirSync(inboxDir, { recursive: true });

    const prefix = `${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
    const safeName = path.basename(att.name).replace(/[^a-zA-Z0-9._-]/g, '_');
    const filename = `${prefix}-${safeName}`;
    const dest = path.join(inboxDir, filename);

    const buffer = Buffer.from(att.data, 'base64');
    if (att.size > 0 && buffer.length !== att.size) {
      logger.warn({ name: att.name, expected: att.size, got: buffer.length }, 'Attachment size mismatch — file may be truncated');
    }
    fs.writeFileSync(dest, buffer);

    return path.join('inbox', 'attachments', filename);
  }

  private startFileServer(): void {
    fs.mkdirSync(this.filesDir, { recursive: true });

    this.fileServer = http.createServer((req, res) => {
      if (!req.url?.startsWith('/files/')) {
        res.writeHead(404);
        res.end();
        return;
      }

      const relativePath = req.url.slice('/files/'.length);
      const resolved = path.resolve(this.filesDir, relativePath);
      if (!resolved.startsWith(path.resolve(this.filesDir) + path.sep) &&
          resolved !== path.resolve(this.filesDir)) {
        res.writeHead(403);
        res.end();
        return;
      }

      if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
        res.writeHead(404);
        res.end();
        return;
      }

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', this.getMimeType(path.extname(resolved)));
      fs.createReadStream(resolved).pipe(res);
    });

    this.fileServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.warn({ port: this.filesPort }, 'Files port already in use — HTTP server not started');
      } else {
        logger.error({ err }, 'File server error');
      }
    });

    this.fileServer.listen(this.filesPort, '127.0.0.1');
  }

  private getMimeType(ext: string): string {
    const map: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.csv': 'text/csv',
      '.html': 'text/html',
      '.md': 'text/markdown',
      '.zip': 'application/zip',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
    };
    return map[ext.toLowerCase()] ?? 'application/octet-stream';
  }

  private extractOutboundAttachments(text: string): Array<{ name: string; url: string }> {
    // Acepta paths del contenedor (/workspace/group/files/...) y paths relativos (files/...)
    const regex = /(?:\/workspace\/group\/)?files\/([^\s\]"']+)/g;
    const attachments: Array<{ name: string; url: string }> = [];
    const seen = new Set<string>();

    let match;
    while ((match = regex.exec(text)) !== null) {
      const filename = match[1];
      if (seen.has(filename)) continue;
      seen.add(filename);

      const fullPath = path.join(this.filesDir, filename);
      if (fs.existsSync(fullPath)) {
        attachments.push({
          name: path.basename(filename),
          url: `/files/${filename}`,
        });
      }
    }

    return attachments;
  }

  async connect(): Promise<void> {
    // Start HTTP file server first (independent of WS)
    this.startFileServer();

    this.wss = new WebSocketServer({ port: this.port });

    // CRITICAL: register chat metadata immediately so SQLite FK constraint is satisfied
    this.opts.onChatMetadata(
      WS_JID,
      new Date().toISOString(),
      'better-work',
      'websocket',
      false,
    );

    this.wss.on('connection', (ws: WebSocket) => {
      // If there's already a client, terminate it before accepting the new one
      if (this.client) {
        this.client.terminate();
      }

      this.client = ws;
      let isAlive = true;

      // Clear any existing heartbeat before starting a new one
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      if (this.pongTimeout) {
        clearTimeout(this.pongTimeout);
        this.pongTimeout = null;
      }

      ws.on('pong', () => {
        isAlive = true;
        if (this.pongTimeout) {
          clearTimeout(this.pongTimeout);
          this.pongTimeout = null;
        }
      });

      this.heartbeatInterval = setInterval(() => {
        if (!isAlive) {
          ws.terminate();
          return;
        }
        isAlive = false;
        ws.ping();
        this.pongTimeout = setTimeout(() => {
          ws.terminate();
        }, PONG_TIMEOUT_MS);
      }, HEARTBEAT_INTERVAL_MS);

      // Send connected event, then flush buffer
      ws.send(
        JSON.stringify({
          type: 'system',
          event: 'connected',
          payload: { buffered_count: this.buffer.length },
        }),
      );

      this.flushBuffer(ws);

      ws.on('message', (raw: Buffer) => {
        this.handleInboundMessage(ws, raw.toString());
      });

      ws.on('close', () => {
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
        if (this.pongTimeout) {
          clearTimeout(this.pongTimeout);
          this.pongTimeout = null;
        }
        this.client = null;

        // Notify agent that client disconnected
        const msg: NewMessage = {
          id: crypto.randomUUID(),
          chat_jid: WS_JID,
          sender: 'ws:system',
          sender_name: 'System',
          content: '[SYSTEM] client_disconnected: {}',
          timestamp: new Date().toISOString(),
        };
        this.opts.onMessage(WS_JID, msg);
      });

      ws.on('error', (err: Error) => {
        logger.error({ err }, 'WebSocket client error');
      });
    });
  }

  private handleInboundMessage(ws: WebSocket, raw: string): void {
    let msg: { type: string; content?: string; action?: string; payload?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'PARSE_ERROR',
          message: 'Invalid JSON',
        }),
      );
      return;
    }

    if (msg.type === 'chat') {
      // content puede estar vacío si el mensaje solo tiene attachments
      let content = (msg as { type: string; content?: string; attachments?: InboundAttachment[] }).content ?? '';

      const inboundMsg = msg as { type: string; content?: string; attachments?: InboundAttachment[] };
      if (Array.isArray(inboundMsg.attachments) && inboundMsg.attachments.length > 0) {
        const refs: string[] = [];
        for (const att of inboundMsg.attachments) {
          try {
            const relPath = this.saveInboundAttachment(att);
            refs.push(relPath);
          } catch (err) {
            logger.warn({ err, name: att.name }, 'Failed to save attachment');
          }
        }
        if (refs.length > 0) {
          const refBlock = refs.length === 1
            ? `\n\n[Attachment: ${refs[0]}]`
            : `\n\n[Attachments:\n${refs.map(r => `- ${r}`).join('\n')}]`;
          content = content + refBlock;
        }
      }

      // Solo procesar si hay content (texto o referencia de adjunto)
      if (content.length > 0) {
        const newMsg: NewMessage = {
          id: crypto.randomUUID(),
          chat_jid: WS_JID,
          sender: 'ws:user',
          sender_name: 'User',
          content,
          timestamp: new Date().toISOString(),
        };
        this.opts.onMessage(WS_JID, newMsg);
      }
    } else if (msg.type === 'system') {
      const content = `[SYSTEM] ${msg.action}: ${JSON.stringify(msg.payload ?? {})}`;
      const newMsg: NewMessage = {
        id: crypto.randomUUID(),
        chat_jid: WS_JID,
        sender: 'ws:user',
        sender_name: 'User',
        content,
        timestamp: new Date().toISOString(),
      };
      this.opts.onMessage(WS_JID, newMsg);
    }
    // Unknown types are ignored silently
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    const attachments = this.extractOutboundAttachments(text);
    const payload: Record<string, unknown> = { type: 'chat', content: text };
    if (attachments.length > 0) {
      payload.attachments = attachments;
    }
    const serialized = JSON.stringify(payload);

    if (this.isConnected()) {
      this.client!.send(serialized);
    } else {
      // Buffer solo el text — al hacer flush, extractOutboundAttachments se re-ejecuta
      this.bufferMessage(text);
    }
  }

  private bufferMessage(content: string): void {
    if (this.buffer.length >= MAX_BUFFER) {
      this.buffer.shift(); // drop oldest
    }
    this.buffer.push({ content, timestamp: new Date().toISOString() });
  }

  private flushBuffer(ws: WebSocket): void {
    if (this.buffer.length === 0) return;

    const count = this.buffer.length;
    ws.send(JSON.stringify({ type: 'system', event: 'buffered_start', count }));

    for (const buffered of this.buffer) {
      const attachments = this.extractOutboundAttachments(buffered.content);
      const payload: Record<string, unknown> = {
        type: 'chat',
        content: buffered.content,
        timestamp: buffered.timestamp,
      };
      if (attachments.length > 0) {
        payload.attachments = attachments;
      }
      ws.send(JSON.stringify(payload));
    }

    ws.send(JSON.stringify({ type: 'system', event: 'buffered_end' }));
    this.buffer = [];
  }

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('ws:');
  }

  async setTyping(_jid: string, isTyping: boolean): Promise<void> {
    this.client?.send(
      JSON.stringify({
        type: 'system',
        event: 'typing',
        payload: { isTyping },
      }),
    );
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
    // Cerrar HTTP file server
    if (this.fileServer) {
      this.fileServer.close();
      this.fileServer = null;
    }
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.client = null;
  }
}
