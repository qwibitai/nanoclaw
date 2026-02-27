import net from 'net';

import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const MAX_PENDING_RPC = 100;
const MAX_OUTGOING_QUEUE = 1000;
const MAX_BUFFER_SIZE = 1_000_000; // 1MB

/**
 * Replace U+FFFC mention placeholders with @name text.
 * signal-cli encodes @mentions as {start, length, uuid, number, name} objects
 * and puts U+FFFC in the message body at each mention position.
 */
export function resolveMentions(
  text: string | undefined,
  mentions: Array<Record<string, unknown>> | undefined,
  phoneNumber: string,
  assistantName: string,
): string | undefined {
  if (!text || !mentions || mentions.length === 0) return text;

  const sorted = [...mentions].sort(
    (a, b) => (b.start as number) - (a.start as number),
  );

  let result = text;
  for (const mention of sorted) {
    const start = mention.start as number;
    const length = (mention.length as number) || 1;
    const number = mention.number as string | undefined;
    // Map mentions of our own number to the assistant name so triggers match
    const name = (number === phoneNumber)
      ? assistantName
      : (mention.name as string) || number || 'unknown';
    result = result.slice(0, start) + `@${name}` + result.slice(start + length);
  }

  return result;
}

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  assistantName?: string;
}

/**
 * Signal channel via signal-cli daemon in TCP JSON-RPC mode.
 * Bidirectional: sends requests AND receives notifications over the same socket.
 * Zero npm dependencies.
 */
export class SignalChannel implements Channel {
  name = 'signal';

  private phoneNumber: string;
  private host: string;
  private port: number;
  private opts: SignalChannelOpts;
  private assistantName: string;
  private connected = false;
  private socket: net.Socket | null = null;
  private rpcId = 0;
  private pendingRequests = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = '';
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private reconnectAttempts = 0;

  constructor(phoneNumber: string, daemonUrl: string, opts: SignalChannelOpts) {
    this.phoneNumber = phoneNumber;
    // Parse host:port from URL like "tcp://localhost:8080" or "localhost:8080"
    const cleaned = daemonUrl.replace(/^tcp:\/\//, '').replace(/\/$/, '');
    const [host, portStr] = cleaned.split(':');
    this.host = host || 'localhost';
    this.port = parseInt(portStr || '7583', 10);
    this.opts = opts;
    this.assistantName = opts.assistantName || 'Andy';
  }

  async connect(): Promise<void> {
    await this.connectSocket();
    this.connected = true;

    // Subscribe to receive notifications (required for some daemon configurations)
    try {
      await this.rpcCall('subscribeReceive', {});
    } catch {
      logger.debug('subscribeReceive not available, relying on automatic notifications');
    }

    logger.info({ phone: this.phoneNumber }, 'Signal channel connected');
    console.log(`\n  Signal: ${this.phoneNumber}`);
    console.log(`  Daemon: ${this.host}:${this.port}\n`);

    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush Signal outgoing queue'),
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected || !this.socket) {
      this.enqueue(jid, text);
      return;
    }

    try {
      const isGroup = jid.startsWith('sig:g:');
      const target = isGroup ? jid.slice(6) : jid.slice(4);

      const params: Record<string, unknown> = { message: text };
      if (isGroup) {
        params.groupId = target;
      } else {
        params.recipient = [target];
      }

      await this.rpcCall('send', params);
      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      this.enqueue(jid, text);
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send Signal message, queued');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sig:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.flushing = false;
    this.buffer = '';
    this.outgoingQueue = [];
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const [, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();
    logger.info('Signal channel stopped');
  }

  // --- Private ---

  private enqueue(jid: string, text: string): void {
    if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE) {
      const dropped = this.outgoingQueue.shift();
      logger.warn({ droppedJid: dropped?.jid, queueSize: this.outgoingQueue.length }, 'Signal outgoing queue full, dropping oldest');
    }
    this.outgoingQueue.push({ jid, text });
    logger.info({ jid, length: text.length, queueSize: this.outgoingQueue.length }, 'Signal message queued');
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing Signal outgoing queue');
      while (this.outgoingQueue.length > 0 && this.connected) {
        const item = this.outgoingQueue.shift()!;
        const isGroup = item.jid.startsWith('sig:g:');
        const target = isGroup ? item.jid.slice(6) : item.jid.slice(4);
        const params: Record<string, unknown> = { message: item.text };
        if (isGroup) params.groupId = target;
        else params.recipient = [target];
        await this.rpcCall('send', params);
        logger.info({ jid: item.jid, length: item.text.length }, 'Queued Signal message sent');
      }
    } catch (err) {
      logger.error({ err }, 'Error flushing Signal queue');
    } finally {
      this.flushing = false;
    }
  }

  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.socket = socket;
        this.reconnectAttempts = 0;
        resolve();
      });

      socket.setEncoding('utf8');

      socket.on('data', (data: string) => {
        this.buffer += data;
        if (this.buffer.length > MAX_BUFFER_SIZE) {
          logger.warn({ size: this.buffer.length }, 'Signal TCP buffer exceeded cap, truncating');
          this.buffer = this.buffer.slice(-MAX_BUFFER_SIZE);
        }
        this.processBuffer();
      });

      socket.on('error', (err) => {
        if (!this.connected) {
          reject(err);
          return;
        }
        logger.error({ err: err.message }, 'Signal TCP error, reconnecting...');
        this.reconnect();
      });

      socket.on('close', () => {
        if (this.connected) {
          logger.warn('Signal TCP connection closed, reconnecting...');
          this.reconnect();
        }
      });

      // Timeout for initial connection
      socket.setTimeout(10000, () => {
        socket.destroy();
        reject(new Error(`signal-cli daemon not reachable at ${this.host}:${this.port}`));
      });

      // Clear timeout after connected
      socket.once('connect', () => socket.setTimeout(0));
    });
  }

  private reconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.buffer = '';
    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;
    setTimeout(() => {
      if (!this.connected) return;
      this.connectSocket()
        .then(() => this.flushOutgoingQueue())
        .catch((err) => {
          logger.error({ err: err.message }, 'Signal reconnection failed, retrying...');
          this.reconnect();
        });
    }, delay);
  }

  private processBuffer(): void {
    // JSON-RPC over TCP: each message is a complete JSON object on one line
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this.handleJsonRpc(msg);
      } catch {
        logger.debug({ line: trimmed.slice(0, 200) }, 'Failed to parse JSON-RPC line');
      }
    }
  }

  private handleJsonRpc(msg: Record<string, any>): void {
    // Response to a request we sent
    if (msg.id != null && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || 'RPC error'));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Notification from the daemon (incoming message)
    if (msg.method === 'receive') {
      const params = msg.params;
      // Automatic notification: params.envelope directly
      if (params?.envelope) {
        this.handleEnvelope({ envelope: params.envelope });
      }
      // Subscription notification: params.result.envelope
      else if (params?.result?.envelope) {
        this.handleEnvelope({ envelope: params.result.envelope });
      }
      return;
    }

    // Some daemon versions wrap differently
    if (msg.envelope) {
      this.handleEnvelope(msg);
      return;
    }
  }

  private rpcCall(method: string, params: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.pendingRequests.size >= MAX_PENDING_RPC) {
        reject(new Error(`RPC cap exceeded (${MAX_PENDING_RPC} pending calls)`));
        return;
      }

      if (!this.socket) {
        reject(new Error('Not connected'));
        return;
      }

      const id = ++this.rpcId;
      const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timer });

      this.socket.write(request, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  handleEnvelope(event: Record<string, any>): void {
    const envelope = event.envelope;
    if (!envelope) return;

    // Handle sync messages (sent from own device)
    const syncMsg = envelope.syncMessage?.sentMessage;
    const dataMsg = envelope.dataMessage;
    const msg = dataMsg || syncMsg;
    if (!msg) return;

    const sender: string = dataMsg
      ? (envelope.source || envelope.sourceNumber || '')
      : (syncMsg?.destination || this.phoneNumber);
    const senderName: string = dataMsg
      ? (envelope.sourceName || sender)
      : (envelope.sourceName || 'Me');
    const timestamp = new Date(envelope.timestamp).toISOString();
    let content: string = resolveMentions(
      msg.message,
      msg.mentions,
      this.phoneNumber,
      this.assistantName,
    ) || '';
    const groupId: string | undefined = msg.groupInfo?.groupId;

    if (!content && !msg.attachments?.length) return;

    // Determine JID and chat name
    const chatJid = groupId ? `sig:g:${groupId}` : `sig:${syncMsg ? (syncMsg.destination || this.phoneNumber) : sender}`;
    const chatName = groupId ? (msg.groupInfo?.groupName || 'Signal Group') : senderName;
    const isGroup = !!groupId;

    // Handle /chatid command
    if (content.trim().toLowerCase() === '/chatid') {
      this.sendMessage(chatJid, `Chat ID: ${chatJid}`).catch((err) =>
        logger.warn({ err, chatJid }, 'Failed to send /chatid response'),
      );
      return;
    }

    // Handle attachments as placeholders
    if (msg.attachments && msg.attachments.length > 0) {
      const descs = msg.attachments.map((att: Record<string, any>) => {
        const ct: string = att.contentType || '';
        const name: string = att.filename || att.id || 'file';
        if (ct.startsWith('image/')) return `[Image: ${name}]`;
        if (ct.startsWith('video/')) return `[Video: ${name}]`;
        if (ct.startsWith('audio/')) return `[Audio: ${name}]`;
        return `[File: ${name}]`;
      });
      content = content ? `${content}\n${descs.join('\n')}` : descs.join('\n');
    }

    // Handle quote/reply context
    if (msg.quote) {
      const quoteAuthor = msg.quote.authorName || msg.quote.author || 'someone';
      content = `[Reply to ${quoteAuthor}] ${content}`;
    }

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'signal', isGroup);

    // Only deliver for registered chats
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid, chatName }, 'Message from unregistered Signal chat');
      return;
    }

    const isFromMe = !!syncMsg || sender === this.phoneNumber;
    // "Note to Self" is a sync message sent to our own number — treat as user input
    const isNoteToSelf = !!syncMsg && !isGroup && sender === this.phoneNumber;
    const isBotMessage = isFromMe && !isNoteToSelf;

    this.opts.onMessage(chatJid, {
      id: `sig_${envelope.timestamp}_${sender}`,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isFromMe,
      is_bot_message: isBotMessage,
    });

    logger.info({ chatJid, sender: senderName }, 'Signal message stored');
  }
}
