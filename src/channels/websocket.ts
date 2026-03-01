import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { Channel, NewMessage, OnInboundMessage, OnChatMetadata } from '../types.js';
import { logger } from '../logger.js';

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

export class WebSocketChannel implements Channel {
  name = 'websocket';
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private buffer: BufferedMessage[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly port: number,
    private readonly opts: WebSocketChannelOpts,
  ) {}

  async connect(): Promise<void> {
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

    if (msg.type === 'chat' && typeof msg.content === 'string') {
      const newMsg: NewMessage = {
        id: crypto.randomUUID(),
        chat_jid: WS_JID,
        sender: 'ws:user',
        sender_name: 'User',
        content: msg.content,
        timestamp: new Date().toISOString(),
      };
      this.opts.onMessage(WS_JID, newMsg);
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
    if (this.isConnected()) {
      this.client!.send(JSON.stringify({ type: 'chat', content: text }));
    } else {
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
      ws.send(
        JSON.stringify({
          type: 'chat',
          content: buffered.content,
          timestamp: buffered.timestamp,
        }),
      );
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
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.client = null;
  }
}
