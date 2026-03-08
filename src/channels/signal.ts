import { existsSync } from 'fs';
import fs from 'fs/promises';
import net from 'net';
import path from 'path';

import { ASSISTANT_NAME } from '../config.js';
import {
  deleteReactionByTarget,
  getLatestMessage,
  getMessageById,
  storeReaction,
} from '../db.js';
import { logger } from '../logger.js';
import {
  Attachment,
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  accountNumber: string;
  socketPath?: string;
}

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

interface SignalRawAttachment {
  id: number | string;
  contentType: string;
  filename?: string;
  size?: number;
  width?: number;
  height?: number;
  voiceNote?: boolean;
  caption?: string;
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  groupInfo?: { groupId: string; type?: string };
  quote?: SignalQuote;
  reaction?: {
    emoji: string;
    targetAuthor: string;
    targetSentTimestamp: number;
    isRemove: boolean;
  };
  attachments?: SignalRawAttachment[];
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
  private lastSentTimestamps: Map<string, number> = new Map();
  private opts: SignalChannelOpts;
  private socketPath: string;
  private rpcId = 0;
  private pendingRpc = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = '';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(opts: SignalChannelOpts) {
    this.opts = opts;
    this.socketPath = opts.socketPath || DEFAULT_SOCKET_PATH;
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
        account: this.opts.accountNumber,
        groupId,
        message: prefixed,
      })) as { timestamp?: number } | null;
    } else {
      const recipient = jid.slice('signal:'.length);
      result = (await this.rpcCall('send', {
        account: this.opts.accountNumber,
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
      account: this.opts.accountNumber,
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
        ? this.opts.accountNumber
        : msg.sender
      : this.opts.accountNumber;

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
      account: this.opts.accountNumber,
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
      ? this.opts.accountNumber
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
          account: this.opts.accountNumber,
          groupId,
          stop: !isTyping,
        });
      } else {
        const recipient = jid.slice('signal:'.length);
        await this.rpcCall('sendTyping', {
          account: this.opts.accountNumber,
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
        account: this.opts.accountNumber,
      })) as Array<{ id: string; name?: string }>;

      if (!Array.isArray(result)) return;

      for (const group of result) {
        if (group.id && group.name) {
          const chatJid = `signal:group:${group.id}`;
          this.opts.onChatMetadata(
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
      source = this.opts.accountNumber; // It's from you
      senderName = 'You';
    } else if (envelope.dataMessage) {
      // Regular message from someone else
      dataMessage = envelope.dataMessage;
      source = envelope.sourceNumber || envelope.source || '';
      senderName = envelope.sourceName || source;
    } else {
      return;
    }

    // Handle incoming reactions before regular message processing
    const reaction = dataMessage?.reaction;
    if (reaction) {
      const groupId = dataMessage.groupInfo?.groupId;
      const chatJid = groupId ? `signal:group:${groupId}` : `signal:${source}`;
      const timestamp = envelope.timestamp
        ? new Date(envelope.timestamp).toISOString()
        : new Date().toISOString();
      const groups = this.opts.registeredGroups();
      if (groups[chatJid]) {
        if (reaction.isRemove) {
          deleteReactionByTarget(chatJid, reaction.targetSentTimestamp, source);
        } else {
          this.opts.onMessage(chatJid, {
            id: `reaction-${source}-${envelope.timestamp ?? Date.now()}`,
            chat_jid: chatJid,
            sender: source,
            sender_name: senderName,
            content: `[reacted ${reaction.emoji} to a message]`,
            timestamp,
            is_from_me: source === this.opts.accountNumber,
            is_bot_message: false,
            is_reaction: true,
            reaction_emoji: reaction.emoji,
            reaction_target_timestamp: String(reaction.targetSentTimestamp),
            reaction_target_author: reaction.targetAuthor,
          });
        }
      }
      return;
    }

    const rawAttachments = dataMessage?.attachments;
    if (!dataMessage?.message && !rawAttachments?.length) return;

    const groupId = dataMessage.groupInfo?.groupId;
    const chatJid = groupId ? `signal:group:${groupId}` : `signal:${source}`;
    const isGroup = !!groupId;

    const timestamp = dataMessage.timestamp
      ? new Date(dataMessage.timestamp).toISOString()
      : new Date().toISOString();

    // Always emit chat metadata for discovery
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'signal', isGroup);

    // Extract reply-threading quote fields if present
    const quote = dataMessage.quote;
    const quotedMessageId =
      quote?.id != null ? `signal-${quote.id}` : undefined;
    const quoteSenderName = quote?.authorName || quote?.author || undefined;
    const quoteContent = quote?.text || undefined;

    // Parse attachments and build human-readable descriptions
    let attachments: Attachment[] | undefined;
    let content = dataMessage.message || '';

    if (rawAttachments?.length) {
      attachments = rawAttachments.map((a) => ({
        id: String(a.id),
        contentType: a.contentType,
        filename: a.filename || undefined,
        size: a.size,
        width: a.width,
        height: a.height,
        isVoiceNote: a.voiceNote || false,
        caption: a.caption || undefined,
      }));

      const descriptions = attachments
        .map((a) => {
          const sizeKB = Math.round((a.size || 0) / 1024);
          const name = a.filename || 'unnamed';
          const dims = a.width && a.height ? ` ${a.width}x${a.height}` : '';
          const voice = a.isVoiceNote ? ' (voice note)' : '';
          return `[attachment: ${name} (${a.contentType}, ${sizeKB}KB${dims}${voice})]`;
        })
        .join('\n');

      content = content ? `${content}\n${descriptions}` : descriptions;
    }

    // Deliver message for registered groups
    const groups = this.opts.registeredGroups();
    if (groups[chatJid]) {
      this.opts.onMessage(chatJid, {
        id: `signal-${dataMessage.timestamp || Date.now()}`,
        chat_jid: chatJid,
        sender: source,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: source === this.opts.accountNumber,
        is_bot_message: false,
        quoted_message_id: quotedMessageId,
        quote_sender_name: quoteSenderName,
        quote_content: quoteContent,
        attachments,
      });
    }
  }

  private rpcCall(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000,
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

      setTimeout(() => {
        if (this.pendingRpc.has(id)) {
          this.pendingRpc.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }
      }, timeoutMs);
    });
  }

  async downloadAttachment(
    attachment: Attachment,
    destDir: string,
  ): Promise<string | null> {
    const safeName = (
      attachment.filename || `attachment.${mimeToExt(attachment.contentType)}`
    ).replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(destDir, `${attachment.id}-${safeName}`);
    if (existsSync(filePath)) return filePath;

    const result = (await this.rpcCall(
      'getAttachment',
      { account: this.opts.accountNumber, id: attachment.id },
      120_000,
    )) as { data?: string } | null;
    if (!result?.data) return null;

    const buffer = Buffer.from(result.data, 'base64');
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(filePath, buffer);

    return filePath;
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

function mimeToExt(contentType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
  };
  return map[contentType] || 'bin';
}
