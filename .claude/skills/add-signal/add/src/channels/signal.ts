import net from 'net';

import { ASSISTANT_NAME } from '../config.js';
import { getLatestMessage, getMessageById, storeReaction } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface SignalQuote {
  id?: number;
  author?: string;
  authorName?: string;
  text?: string;
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  groupInfo?: { groupId: string; type?: string };
  quote?: SignalQuote;
}

interface SignalEnvelope {
  source?: string;
  sourceName?: string;
  sourceNumber?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
  syncMessage?: {
    sentMessage?: SignalDataMessage;
  };
  typingMessage?: {
    action?: string;
    groupId?: string;
  };
}

const DEFAULT_SOCKET_PATH = '/tmp/signal-cli.sock';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

export class SignalChannel implements Channel {
  name = 'signal';

  private socket: net.Socket | null = null;
  private connected = false;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;
  private accountNumber: string;
  private socketPath: string;
  private rpcId = 0;
  private pendingRpc = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = '';
  private lastSentTimestamps: Map<string, number> = new Map();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(
    opts: ChannelOpts,
    accountNumber: string,
    socketPath?: string,
  ) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
    this.accountNumber = accountNumber;
    this.socketPath = socketPath || DEFAULT_SOCKET_PATH;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve, reject);
    });
  }

  private connectInternal(
    onFirstOpen?: () => void,
    onFirstError?: (err: Error) => void,
  ): void {
    const sock = net.createConnection({ path: this.socketPath });
    this.socket = sock;

    sock.on('connect', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info(
        { socketPath: this.socketPath },
        'Connected to signal-cli daemon',
      );

      // Sync group metadata on connect
      this.syncGroupMetadata().catch((err) =>
        logger.warn({ err }, 'Signal group sync failed'),
      );

      if (onFirstOpen) {
        onFirstOpen();
        onFirstOpen = undefined;
        onFirstError = undefined;
      }
    });

    sock.on('data', (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    sock.on('error', (err) => {
      logger.error({ err }, 'Signal socket error');
      if (onFirstError) {
        onFirstError(err);
        onFirstError = undefined;
        onFirstOpen = undefined;
      }
    });

    sock.on('close', () => {
      this.connected = false;
      // Reject any pending RPCs
      for (const [id, pending] of this.pendingRpc) {
        pending.reject(new Error('Socket closed'));
        this.pendingRpc.delete(id);
      }

      if (!this.shuttingDown) {
        this.scheduleReconnect();
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const prefixed = `${ASSISTANT_NAME}: ${text}`;

    let result: { timestamp?: number } | null = null;
    if (jid.startsWith('signal:group:')) {
      const groupId = jid.slice('signal:group:'.length);
      result = (await this.rpcCall('send', {
        account: this.accountNumber,
        groupId,
        message: prefixed,
      })) as { timestamp?: number } | null;
    } else {
      const recipient = jid.slice('signal:'.length);
      result = (await this.rpcCall('send', {
        account: this.accountNumber,
        recipient: [recipient],
        message: prefixed,
      })) as { timestamp?: number } | null;
    }
    if (result?.timestamp) {
      this.lastSentTimestamps.set(jid, result.timestamp);
    }
    logger.info({ jid, length: prefixed.length }, 'Signal message sent');
  }

  async editMessage(
    jid: string,
    newText: string,
    originalTimestamp?: number,
  ): Promise<number> {
    const editTimestamp = originalTimestamp ?? this.lastSentTimestamps.get(jid);
    if (!editTimestamp) {
      throw new Error('No message to edit — no stored timestamp for this chat');
    }

    const params: Record<string, unknown> = {
      account: this.accountNumber,
      message: `${ASSISTANT_NAME}: ${newText}`,
      editTimestamp,
    };

    if (jid.startsWith('signal:group:')) {
      params.groupId = jid.slice('signal:group:'.length);
    } else {
      params.recipient = [jid.slice('signal:'.length)];
    }

    await this.rpcCall('send', params);
    logger.info({ jid, editTimestamp }, 'Signal message edited');
    return editTimestamp;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    this.socket?.destroy();
    this.socket = null;
    logger.info('Signal channel disconnected');
  }

  async sendReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    // messageId format: "signal-{timestamp}"
    const ts = messageId.startsWith('signal-')
      ? parseInt(messageId.slice('signal-'.length), 10)
      : parseInt(messageId, 10);
    if (!ts || isNaN(ts)) {
      logger.warn(
        { jid, messageId },
        'Cannot send Signal reaction: invalid message ID',
      );
      return;
    }

    const msg = getMessageById(messageId);
    const targetAuthor = msg
      ? msg.is_from_me
        ? this.accountNumber
        : msg.sender
      : this.accountNumber;

    await this.cliSendReaction(jid, emoji, targetAuthor, ts, messageId);
  }

  private async cliSendReaction(
    jid: string,
    emoji: string,
    targetAuthor: string,
    targetTimestamp: number,
    messageId: string,
  ): Promise<void> {
    const params: Record<string, unknown> = {
      account: this.accountNumber,
      emoji,
      targetAuthor,
      targetTimestamp,
    };

    if (jid.startsWith('signal:group:')) {
      params.groupId = jid.slice('signal:group:'.length);
    } else {
      params.recipient = [jid.slice('signal:'.length)];
    }

    try {
      await this.rpcCall('sendReaction', params);
      storeReaction({
        chatJid: jid,
        messageId,
        emoji,
        timestamp: new Date().toISOString(),
      });
      logger.debug({ jid, messageId, emoji }, 'Signal reaction sent');
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Failed to send Signal reaction',
      );
    }
  }

  async reactToLatestMessage(jid: string, emoji: string): Promise<void> {
    const latest = getLatestMessage(jid);
    if (!latest) {
      logger.warn({ jid }, 'No latest message in DB for reaction');
      return;
    }

    // Determine the author of the message being reacted to
    const targetAuthor = latest.is_from_me
      ? this.accountNumber
      : latest.sender;

    const ts = latest.id.startsWith('signal-')
      ? parseInt(latest.id.slice('signal-'.length), 10)
      : parseInt(latest.id, 10);
    if (!ts || isNaN(ts)) {
      logger.warn(
        { jid, id: latest.id },
        'Cannot parse timestamp from message ID',
      );
      return;
    }

    await this.cliSendReaction(jid, emoji, targetAuthor, ts, latest.id);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      if (jid.startsWith('signal:group:')) {
        const groupId = jid.slice('signal:group:'.length);
        await this.rpcCall('sendTyping', {
          account: this.accountNumber,
          groupId,
          stop: !isTyping,
        });
      } else {
        const recipient = jid.slice('signal:'.length);
        await this.rpcCall('sendTyping', {
          account: this.accountNumber,
          recipient: [recipient],
          stop: !isTyping,
        });
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Signal typing indicator');
    }
  }

  // --- Private ---

  private async syncGroupMetadata(): Promise<void> {
    try {
      const result = (await this.rpcCall('listGroups', {
        account: this.accountNumber,
      })) as Array<{ id: string; name?: string }>;

      if (!Array.isArray(result)) return;

      for (const group of result) {
        if (group.id && group.name) {
          const chatJid = `signal:group:${group.id}`;
          this.onChatMetadata(
            chatJid,
            new Date().toISOString(),
            group.name,
            'signal',
            true,
          );
        }
      }
      logger.info({ count: result.length }, 'Signal group metadata synced');
    } catch (err) {
      logger.warn({ err }, 'Failed to list Signal groups');
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // Keep the last (potentially incomplete) line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.id !== undefined && this.pendingRpc.has(parsed.id)) {
          // RPC response
          const pending = this.pendingRpc.get(parsed.id)!;
          this.pendingRpc.delete(parsed.id);
          const resp = parsed as JsonRpcResponse;
          if (resp.error) {
            pending.reject(
              new Error(`RPC error ${resp.error.code}: ${resp.error.message}`),
            );
          } else {
            pending.resolve(resp.result);
          }
        } else if (parsed.method) {
          // Notification
          this.handleNotification(parsed as JsonRpcNotification);
        }
      } catch (err) {
        logger.debug({ line: trimmed, err }, 'Failed to parse signal-cli JSON');
      }
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method !== 'receive' && notification.method !== 'sync')
      return;

    const envelope = notification.params?.envelope as
      | SignalEnvelope
      | undefined;
    if (!envelope) return;

    // Handle both regular messages and sync messages (self-sent)
    let dataMessage;
    let source;
    let senderName;

    if (envelope.syncMessage?.sentMessage) {
      // Sync message (your own message from another device)
      dataMessage = envelope.syncMessage.sentMessage;
      source = this.accountNumber; // It's from you
      senderName = 'You';
    } else if (envelope.dataMessage) {
      // Regular message from someone else
      dataMessage = envelope.dataMessage;
      source = envelope.sourceNumber || envelope.source || '';
      senderName = envelope.sourceName || source;
    } else {
      return;
    }

    if (!dataMessage?.message) return;

    const groupId = dataMessage.groupInfo?.groupId;
    const chatJid = groupId ? `signal:group:${groupId}` : `signal:${source}`;
    const isGroup = !!groupId;

    const timestamp = dataMessage.timestamp
      ? new Date(dataMessage.timestamp).toISOString()
      : new Date().toISOString();

    // Always emit chat metadata for discovery
    this.onChatMetadata(chatJid, timestamp, undefined, 'signal', isGroup);

    // Extract reply-threading quote fields if present
    const quote = dataMessage.quote;
    const quotedMessageId =
      quote?.id != null ? `signal-${quote.id}` : undefined;
    const quoteSenderName = quote?.authorName || quote?.author || undefined;
    const quoteContent = quote?.text || undefined;

    // Deliver message for registered groups
    const groups = this.registeredGroups();
    if (groups[chatJid]) {
      this.onMessage(chatJid, {
        id: `signal-${dataMessage.timestamp || Date.now()}`,
        chat_jid: chatJid,
        sender: source,
        sender_name: senderName,
        content: dataMessage.message,
        timestamp,
        is_from_me: source === this.accountNumber,
        is_bot_message: false,
        quoted_message_id: quotedMessageId,
        quote_sender_name: quoteSenderName,
        quote_content: quoteContent,
      });
    }
  }

  private rpcCall(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Signal socket not connected'));
        return;
      }

      const id = ++this.rpcId;
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

      this.pendingRpc.set(id, { resolve, reject });

      this.socket.write(request + '\n', (err) => {
        if (err) {
          this.pendingRpc.delete(id);
          reject(err);
        }
      });

      // Timeout pending RPCs after 30s
      setTimeout(() => {
        if (this.pendingRpc.has(id)) {
          this.pendingRpc.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }
      }, 30000);
    });
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;

    logger.info(
      { attempt: this.reconnectAttempts, delayMs: delay },
      'Scheduling Signal reconnect',
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info('Reconnecting to signal-cli daemon...');
      this.connectInternal();
    }, delay);
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SIGNAL_ACCOUNT_NUMBER', 'SIGNAL_SOCKET_PATH']);
  const accountNumber = envVars.SIGNAL_ACCOUNT_NUMBER;
  if (!accountNumber) {
    logger.info('SIGNAL_ACCOUNT_NUMBER not set, skipping Signal channel');
    return null;
  }
  return new SignalChannel(opts, accountNumber, envVars.SIGNAL_SOCKET_PATH);
});
