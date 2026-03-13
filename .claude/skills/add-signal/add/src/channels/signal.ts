/**
 * Signal messenger channel for NanoClaw.
 *
 * Connects to a signal-cli daemon running on the host via its JSON-RPC Unix
 * socket. This lets NanoClaw send and receive Signal messages without ever
 * handling Signal's encryption keys directly — the daemon owns the keys and
 * the container gets socket access only.
 *
 * Architecture:
 *   Host: signal-cli daemon → Unix socket at SIGNAL_SOCKET_PATH
 *   Container: SignalChannel → connects to mounted socket path
 *
 * Signal message flow:
 *   Inbound:  signal-cli receives → pushes JSON-RPC "receive" notification → we route to NanoClaw
 *   Outbound: NanoClaw calls sendMessage() → we write JSON-RPC "send" request → signal-cli delivers
 *
 * JID format:
 *   Direct messages:  signal:<uuid>          e.g. signal:550e8400-e29b-41d4-a716-446655440000
 *   Group messages:   signal:group:<base64>  e.g. signal:group:abc123==
 *
 * @see https://github.com/AsamK/signal-cli
 */

import * as net from 'net';
import { SIGNAL_PHONE_NUMBER, SIGNAL_SOCKET_PATH } from '../config.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface SignalEnvelope {
  source?: string;
  sourceUuid?: string;
  sourceNumber?: string;
  sourceName?: string;
  timestamp: number;
  dataMessage?: {
    message?: string;
    groupInfo?: {
      groupId: string;
      type?: string;
    };
    attachments?: unknown[];
  };
  syncMessage?: unknown;
  typingMessage?: unknown;
  receiptMessage?: unknown;
}

// ---------------------------------------------------------------------------
// SignalChannel
// ---------------------------------------------------------------------------

export class SignalChannel implements Channel {
  name = 'signal';

  private opts: ChannelOpts;
  private socket: net.Socket | null = null;
  private connected = false;
  private requestId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = '';

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  // ---------------------------------------------------------------------------
  // Channel interface
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    if (!SIGNAL_PHONE_NUMBER) {
      throw new Error(
        'SIGNAL_PHONE_NUMBER is required. Set it to the phone number registered with signal-cli (e.g. +15551234567)',
      );
    }
    if (!SIGNAL_SOCKET_PATH) {
      throw new Error(
        'SIGNAL_SOCKET_PATH is required. Default: /run/user/1000/signal-cli/socket — mount the host socket into the container.',
      );
    }

    await this._connectSocket();
    await this._subscribe();
    this.connected = true;

    logger.info(
      { account: SIGNAL_PHONE_NUMBER, socket: SIGNAL_SOCKET_PATH },
      '[signal] connected to signal-cli daemon',
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.socket || !this.connected) {
      throw new Error('[signal] not connected');
    }

    const { recipient, isGroup } = this._parseJid(jid);

    const params: Record<string, unknown> = {
      account: SIGNAL_PHONE_NUMBER,
      message: text,
    };

    if (isGroup) {
      params.groupId = recipient;
    } else {
      params.recipient = [recipient];
    }

    try {
      await this._rpc('send', params);
      logger.debug({ jid }, '[signal] sent message');
    } catch (err) {
      logger.error({ err, jid }, '[signal] failed to send message');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    logger.info('[signal] disconnected');
  }

  // ---------------------------------------------------------------------------
  // Internal: socket connection
  // ---------------------------------------------------------------------------

  private _connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(SIGNAL_SOCKET_PATH);

      sock.once('connect', () => {
        this.socket = sock;
        logger.debug({ path: SIGNAL_SOCKET_PATH }, '[signal] socket connected');
        resolve();
      });

      sock.once('error', (err) => {
        reject(
          new Error(
            `[signal] Cannot connect to signal-cli socket at ${SIGNAL_SOCKET_PATH}: ${err.message}. ` +
              `Is signal-cli running? Start with: signal-cli -a ${SIGNAL_PHONE_NUMBER} daemon --socket`,
          ),
        );
      });

      // Handle incoming data (newline-delimited JSON)
      sock.on('data', (chunk) => {
        this.buffer += chunk.toString('utf8');
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) this._handleLine(trimmed);
        }
      });

      sock.on('close', () => {
        this.connected = false;
        logger.warn('[signal] socket closed — daemon may have stopped');
      });

      sock.on('error', (err) => {
        logger.error({ err }, '[signal] socket error');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: JSON-RPC
  // ---------------------------------------------------------------------------

  private _handleLine(line: string): void {
    let msg: JsonRpcResponse | JsonRpcNotification;
    try {
      msg = JSON.parse(line);
    } catch {
      logger.debug({ line }, '[signal] unparseable line from daemon');
      return;
    }

    // Response to a pending request
    if ('id' in msg && msg.id !== undefined) {
      const resp = msg as JsonRpcResponse;
      const pending = this.pendingRequests.get(resp.id);
      if (pending) {
        this.pendingRequests.delete(resp.id);
        if (resp.error) {
          pending.reject(new Error(`JSON-RPC error ${resp.error.code}: ${resp.error.message}`));
        } else {
          pending.resolve(resp.result);
        }
      }
      return;
    }

    // Notification (inbound message)
    const notif = msg as JsonRpcNotification;
    if (notif.method === 'receive' && notif.params?.envelope) {
      this._handleEnvelope(notif.params.envelope as SignalEnvelope);
    }
  }

  private _rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.pendingRequests.set(id, { resolve, reject });

      const line = JSON.stringify(req) + '\n';
      this.socket!.write(line, 'utf8', (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });

      // Timeout after 10s
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`[signal] RPC timeout for method ${method} id=${id}`));
        }
      }, 10_000);
    });
  }

  private async _subscribe(): Promise<void> {
    await this._rpc('subscribeReceive', { account: SIGNAL_PHONE_NUMBER });
    logger.debug('[signal] subscribed to receive notifications');
  }

  // ---------------------------------------------------------------------------
  // Internal: inbound message routing
  // ---------------------------------------------------------------------------

  private _handleEnvelope(envelope: SignalEnvelope): void {
    const { dataMessage } = envelope;

    // Only route actual chat messages (ignore typing, receipts, sync)
    if (!dataMessage?.message) return;

    const text = dataMessage.message;
    const timestamp = new Date(envelope.timestamp).toISOString();

    // Determine JID and whether it's a group
    let jid: string;
    let isGroup = false;
    let groupName: string | undefined;

    if (dataMessage.groupInfo?.groupId) {
      jid = `signal:group:${dataMessage.groupInfo.groupId}`;
      isGroup = true;
    } else if (envelope.sourceUuid) {
      jid = `signal:${envelope.sourceUuid}`;
    } else if (envelope.sourceNumber) {
      // Fallback: use phone number if UUID not available
      jid = `signal:${envelope.sourceNumber.replace('+', '')}`;
    } else {
      logger.warn({ envelope }, '[signal] received message with no identifiable sender');
      return;
    }

    const senderName = envelope.sourceName || envelope.sourceNumber || envelope.sourceUuid || jid;

    logger.debug({ jid, isGroup, text: text.slice(0, 80) }, '[signal] inbound message');

    // Report chat metadata (lets NanoClaw discover/register the chat)
    this.opts.onChatMetadata(jid, timestamp, senderName, 'signal', isGroup);

    // Route to NanoClaw's message handler
    this.opts.onMessage(jid, {
      id: `signal-${envelope.timestamp}-${envelope.sourceUuid ?? envelope.sourceNumber}`,
      from: jid,
      body: text,
      timestamp,
    });
  }

  // ---------------------------------------------------------------------------
  // Internal: JID parsing
  // ---------------------------------------------------------------------------

  private _parseJid(jid: string): { recipient: string; isGroup: boolean } {
    // signal:group:<base64id>
    if (jid.startsWith('signal:group:')) {
      return { recipient: jid.slice('signal:group:'.length), isGroup: true };
    }
    // signal:<uuid> or signal:<phone>
    const raw = jid.slice('signal:'.length);
    // If it looks like a UUID, use it directly; otherwise treat as phone number
    const isUuid = /^[0-9a-f-]{36}$/.test(raw);
    const recipient = isUuid ? raw : `+${raw}`;
    return { recipient, isGroup: false };
  }
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerChannel('signal', (opts) => {
  if (!SIGNAL_PHONE_NUMBER || !SIGNAL_SOCKET_PATH) {
    return null; // Silently skip if not configured
  }
  return new SignalChannel(opts);
});
