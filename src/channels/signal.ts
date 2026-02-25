import net from 'net';

import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
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
  private connected = false;
  private socket: net.Socket | null = null;
  private rpcId = 0;
  private pendingRequests = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buffer = '';

  constructor(phoneNumber: string, daemonUrl: string, opts: SignalChannelOpts) {
    this.phoneNumber = phoneNumber;
    // Parse host:port from URL like "tcp://localhost:8080" or "localhost:8080"
    const cleaned = daemonUrl.replace(/^tcp:\/\//, '').replace(/\/$/, '');
    const [host, portStr] = cleaned.split(':');
    this.host = host || 'localhost';
    this.port = parseInt(portStr || '7583', 10);
    this.opts = opts;
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
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected || !this.socket) {
      logger.warn('Signal channel not connected');
      return;
    }

    try {
      const isGroup = jid.startsWith('sig:g:');
      const target = isGroup ? jid.slice(6) : jid.slice(4);

      const params: Record<string, unknown> = {
        message: text,
      };

      if (isGroup) {
        params.groupId = target;
      } else {
        params.recipient = [target];
      }

      await this.rpcCall('send', params);
      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
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
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const { reject } of this.pendingRequests.values()) {
      reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();
    logger.info('Signal channel stopped');
  }

  // --- Private ---

  private connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.socket = socket;
        resolve();
      });

      socket.setEncoding('utf8');

      socket.on('data', (data: string) => {
        this.buffer += data;
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
    setTimeout(() => {
      if (!this.connected) return;
      this.connectSocket().catch((err) => {
        logger.error({ err: err.message }, 'Signal reconnection failed, retrying...');
        this.reconnect();
      });
    }, 5000);
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
      } catch (err) {
        logger.debug({ line: trimmed.slice(0, 200) }, 'Failed to parse JSON-RPC line');
      }
    }
  }

  private handleJsonRpc(msg: Record<string, any>): void {
    // Response to a request we sent
    if (msg.id != null && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
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
      if (!this.socket) {
        reject(new Error('Not connected'));
        return;
      }

      const id = ++this.rpcId;
      const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

      this.pendingRequests.set(id, { resolve, reject });

      this.socket.write(request, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });

      // Timeout pending requests after 30s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 30000);
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
    let content: string = msg.message || '';
    const groupId: string | undefined = msg.groupInfo?.groupId;

    if (!content && !msg.attachments?.length) return;

    // Determine JID and chat name
    const chatJid = groupId ? `sig:g:${groupId}` : `sig:${syncMsg ? (syncMsg.destination || this.phoneNumber) : sender}`;
    const chatName = groupId ? (msg.groupInfo?.groupName || 'Signal Group') : senderName;
    const isGroup = !!groupId;

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

    this.opts.onMessage(chatJid, {
      id: `sig_${envelope.timestamp}_${sender}`,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isFromMe,
    });

    logger.info({ chatJid, sender: senderName }, 'Signal message stored');
  }
}
