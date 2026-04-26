import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// QQ Bot API endpoints
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';

// WebSocket opcodes
const OP_HELLO = 10;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_HEARTBEAT = 1;
const OP_HEARTBEAT_ACK = 11;
const OP_DISPATCH = 0;
const OP_RECONNECT = 7;

// QQ Bot intents
const INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  GROUP_AND_C2C: 1 << 25,
};

export interface QQChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Token cache with race condition prevention
interface TokenCache {
  token: string;
  expiresAt: number;
  appId: string;
}

let cachedToken: TokenCache | null = null;
let tokenPromise: Promise<string> | null = null;

/**
 * Get access token with caching and race condition prevention
 */
async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  // Check cache - return valid token immediately
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000 && cachedToken.appId === appId) {
    return cachedToken.token;
  }

  // AppId changed, clear cache and any pending promise
  if (cachedToken && cachedToken.appId !== appId) {
    logger.info({ oldAppId: cachedToken.appId, newAppId: appId }, 'QQ: appId changed, clearing token cache');
    cachedToken = null;
    tokenPromise = null;
  }

  // Return in-flight promise if exists for same appId
  if (tokenPromise && cachedToken?.appId === appId) {
    return tokenPromise;
  }

  // Create new request and cache the promise
  tokenPromise = (async () => {
    try {
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to get access token: ${response.status} ${text}`);
      }

      const data = (await response.json()) as { access_token?: string; expires_in?: number };
      if (!data.access_token) {
        throw new Error('No access_token in response');
      }

      cachedToken = {
        token: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
        appId,
      };

      logger.info({ appId }, 'QQ: Access token obtained');
      return cachedToken.token;
    } finally {
      tokenPromise = null;
    }
  })();

  return tokenPromise;
}

/**
 * Get WebSocket gateway URL
 */
async function getGatewayUrl(accessToken: string): Promise<string> {
  const response = await fetch(`${API_BASE}/gateway`, {
    method: 'GET',
    headers: {
      Authorization: `QQBot ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get gateway URL: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { url?: string };
  if (!data.url) {
    throw new Error('No url in gateway response');
  }

  return data.url;
}

/**
 * Generate message sequence number
 */
function getNextMsgSeq(): number {
  const timePart = Date.now() % 100000000;
  const random = Math.floor(Math.random() * 65536);
  return (timePart ^ random) % 65536;
}

// Message ID to seq mapping for reply tracking with timestamps
interface MsgSeqEntry {
  seq: number;
  createdAt: number;
}
const msgSeqMap = new Map<string, MsgSeqEntry>();
const MSG_SEQ_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Get or create message sequence for a given message ID
 */
function getMsgSeq(msgId?: string): number {
  if (!msgId) return getNextMsgSeq();

  // Cleanup expired entries first
  const now = Date.now();
  if (msgSeqMap.size > 100) {
    for (const [id, entry] of msgSeqMap) {
      if (now - entry.createdAt > MSG_SEQ_TTL) {
        msgSeqMap.delete(id);
      }
    }
  }

  let entry = msgSeqMap.get(msgId);
  if (!entry) {
    entry = { seq: getNextMsgSeq(), createdAt: now };
    msgSeqMap.set(msgId, entry);
  }
  return entry.seq;
}

// Reply limit tracking
const MESSAGE_REPLY_LIMIT = 4;
const MESSAGE_REPLY_TTL = 60 * 60 * 1000; // 1 hour

// QQ API message length limit
const MAX_MESSAGE_LENGTH = 4096;

interface MessageReplyRecord {
  count: number;
  firstReplyAt: number;
}

const messageReplyTracker = new Map<string, MessageReplyRecord>();

function checkMessageReplyLimit(messageId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);

  // Cleanup expired entries on every access (simple TTL-based cleanup)
  if (messageReplyTracker.size > 100) {
    for (const [id, rec] of messageReplyTracker) {
      if (now - rec.firstReplyAt > MESSAGE_REPLY_TTL) {
        messageReplyTracker.delete(id);
      }
    }
  }

  if (!record) {
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }

  if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    messageReplyTracker.delete(messageId);
    return { allowed: true, remaining: MESSAGE_REPLY_LIMIT };
  }

  const remaining = MESSAGE_REPLY_LIMIT - record.count;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

function recordMessageReply(messageId: string): void {
  const now = Date.now();
  const record = messageReplyTracker.get(messageId);

  if (!record) {
    messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else if (now - record.firstReplyAt > MESSAGE_REPLY_TTL) {
    messageReplyTracker.set(messageId, { count: 1, firstReplyAt: now });
  } else {
    record.count++;
  }
}

// WebSocket payload types
interface WSPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

interface HelloData {
  heartbeat_interval: number;
}

interface ReadyData {
  version: number;
  session_id: string;
  user: {
    id: string;
    username: string;
  };
  shard: [number, number];
}

interface C2CMessageEvent {
  author: {
    id: string;
    user_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  attachments?: Array<{
    content_type: string;
    url: string;
    filename?: string;
  }>;
}

interface GroupMessageEvent {
  author: {
    id: string;
    member_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  group_id: string;
  group_openid: string;
  attachments?: Array<{
    content_type: string;
    url: string;
    filename?: string;
  }>;
}

export class QQChannel implements Channel {
  name = 'qq';

  private opts: QQChannelOpts;
  private appId: string;
  private clientSecret: string;
  private ws: WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private lastSeq: number | null = null;
  private reconnectAttempts = 0;
  private isConnecting = false;
  private isAborted = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Message queue for offline buffering
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;

  constructor(appId: string, clientSecret: string, opts: QQChannelOpts) {
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.isConnecting) {
      logger.debug('QQ: Already connecting');
      return;
    }
    this.isConnecting = true;
    this.isAborted = false;

    try {
      await this.doConnect();
    } catch (err) {
      logger.error({ err }, 'QQ: Connection failed');
      this.scheduleReconnect();
    } finally {
      this.isConnecting = false;
    }
  }

  private async doConnect(): Promise<void> {
    this.cleanup();

    const accessToken = await getAccessToken(this.appId, this.clientSecret);
    const gatewayUrl = await getGatewayUrl(accessToken);

    logger.info({ gatewayUrl }, 'QQ: Connecting to gateway');

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(gatewayUrl);
      this.ws = ws;

      const connectTimeout = setTimeout(() => {
        logger.warn('QQ: Connection timeout');
        ws.close();
        reject(new Error('Connection timeout'));
      }, 30000);

      ws.on('open', () => {
        logger.info('QQ: WebSocket connected');
      });

      ws.on('message', (data: WebSocket.RawData) => {
        try {
          const payload: WSPayload = JSON.parse(data.toString());
          this.handleMessage(payload, accessToken, connectTimeout, resolve);
        } catch (err) {
          logger.error({ err, data: data.toString() }, 'QQ: Failed to parse message');
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        logger.info({ code, reason: reason.toString() }, 'QQ: WebSocket closed');
        clearTimeout(connectTimeout);
        this.cleanup();
        if (!this.isAborted) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err: Error) => {
        logger.error({ err }, 'QQ: WebSocket error');
        clearTimeout(connectTimeout);
        reject(err);
      });
    });
  }

  private handleMessage(
    payload: WSPayload,
    accessToken: string,
    connectTimeout: ReturnType<typeof setTimeout>,
    resolve: () => void
  ): void {
    switch (payload.op) {
      case OP_HELLO:
        this.handleHello(payload.d as HelloData, accessToken, connectTimeout, resolve);
        break;

      case OP_HEARTBEAT_ACK:
        logger.debug('QQ: Heartbeat ACK');
        break;

      case OP_DISPATCH:
        this.lastSeq = payload.s ?? null;
        this.handleDispatch(payload, accessToken);
        break;

      case OP_RECONNECT:
        logger.info('QQ: Server requested reconnect');
        this.cleanup();
        this.scheduleReconnect();
        break;

      default:
        logger.debug({ op: payload.op }, 'QQ: Unknown opcode');
    }
  }

  private handleHello(
    data: HelloData,
    accessToken: string,
    connectTimeout: ReturnType<typeof setTimeout>,
    resolve: () => void
  ): void {
    // Start heartbeat with error handling
    this.heartbeatInterval = setInterval(() => {
      try {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.lastSeq }));
          logger.debug('QQ: Heartbeat sent');
        }
      } catch (err) {
        logger.error({ err }, 'QQ: Heartbeat failed');
      }
    }, data.heartbeat_interval);

    // Identify or Resume
    if (this.sessionId) {
      logger.info({ sessionId: this.sessionId }, 'QQ: Resuming session');
      this.ws?.send(
        JSON.stringify({
          op: OP_RESUME,
          d: {
            token: `QQBot ${accessToken}`,
            session_id: this.sessionId,
            seq: this.lastSeq,
          },
        })
      );
    } else {
      logger.info('QQ: Identifying');
      this.ws?.send(
        JSON.stringify({
          op: OP_IDENTIFY,
          d: {
            token: `QQBot ${accessToken}`,
            intents: INTENTS.GROUP_AND_C2C | INTENTS.PUBLIC_GUILD_MESSAGES,
            shard: [0, 1],
            properties: {
              $os: process.platform,
              $browser: 'nanoclaw',
              $device: 'nanoclaw',
            },
          },
        })
      );
    }

    clearTimeout(connectTimeout);
    resolve();
  }

  private handleDispatch(payload: WSPayload, accessToken: string): void {
    const { t, d } = payload;

    switch (t) {
      case 'READY':
        const readyData = d as ReadyData;
        this.sessionId = readyData.session_id;
        logger.info(
          { sessionId: this.sessionId, username: readyData.user?.username },
          'QQ: Ready'
        );
        console.log(`\n  QQ Bot connected: ${readyData.user?.username || 'Unknown'}`);
        this.reconnectAttempts = 0;
        // Flush any queued messages from previous disconnection
        this.flushOutgoingQueue().catch((err) => {
          logger.error({ err }, 'QQ: Failed to flush outgoing queue');
        });
        break;

      case 'RESUMED':
        logger.info('QQ: Session resumed');
        this.reconnectAttempts = 0;
        // Flush any queued messages from previous disconnection
        this.flushOutgoingQueue().catch((err) => {
          logger.error({ err }, 'QQ: Failed to flush outgoing queue');
        });
        break;

      case 'C2C_MESSAGE_CREATE':
        this.handleC2CMessage(d as C2CMessageEvent);
        break;

      case 'GROUP_AT_MESSAGE_CREATE':
        this.handleGroupMessage(d as GroupMessageEvent);
        break;

      default:
        logger.debug({ t }, 'QQ: Unknown dispatch event');
    }
  }

  /**
   * Format attachments into readable string
   */
  private formatAttachments(
    content: string,
    attachments?: Array<{ content_type: string; url: string; filename?: string }>
  ): string {
    if (!attachments?.length) return content;
    const attachmentInfo = attachments
      .map((att) => `[${att.content_type?.startsWith('image/') ? '图片' : '附件'}: ${att.filename || att.url}]`)
      .join('\n');
    return content + '\n' + attachmentInfo;
  }

  private handleC2CMessage(event: C2CMessageEvent): void {
    const openid = event.author.user_openid;
    const chatJid = `qq:${openid}`;

    // Parse QQ face tags
    const content = this.parseFaceTags(event.content);

    const timestamp = event.timestamp;
    const senderName = openid;
    const msgId = event.id;

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, senderName, 'qq', false);

    // Check registration
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'QQ: Message from unregistered chat');
      return;
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: openid,
      sender_name: senderName,
      content: this.formatAttachments(content, event.attachments),
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: senderName }, 'QQ: C2C message received');
  }

  private handleGroupMessage(event: GroupMessageEvent): void {
    const groupOpenid = event.group_openid;
    const chatJid = `qq:group:${groupOpenid}`;
    const senderOpenid = event.author.member_openid;

    // Parse QQ face tags and remove @ mention prefix
    let content = this.parseFaceTags(event.content);
    // Remove @ mention if present
    content = content.replace(/<@!\d+>\s*/g, '').trim();

    const timestamp = event.timestamp;
    const senderName = senderOpenid;
    const msgId = event.id;

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'qq', true);

    // Check registration
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'QQ: Message from unregistered group');
      return;
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderOpenid,
      sender_name: senderName,
      content: this.formatAttachments(content, event.attachments),
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: senderName }, 'QQ: Group message received');
  }

  /**
   * Parse QQ face tags and replace with readable format
   */
  private parseFaceTags(text: string): string {
    if (!text) return text;
    return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_match, ext: string) => {
      try {
        const decoded = Buffer.from(ext, 'base64').toString('utf-8');
        const parsed = JSON.parse(decoded);
        return `【表情: ${parsed.text || '未知表情'}】`;
      } catch {
        return _match;
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.isAborted) return;

    const delays = [1000, 2000, 5000, 10000, 30000, 60000];
    const idx = Math.min(this.reconnectAttempts, delays.length - 1);
    const delay = delays[idx];

    this.reconnectAttempts++;
    logger.info({ delay, attempt: this.reconnectAttempts }, 'QQ: Reconnecting');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
    }
    this.ws = null;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Queue message if disconnected
    if (!this.isConnected()) {
      this.outgoingQueue.push({ jid, text });
      logger.info({ jid, queueSize: this.outgoingQueue.length }, 'QQ: Disconnected, message queued');
      return;
    }

    await this.sendMessageInternal(jid, text);
  }

  private async sendMessageInternal(jid: string, text: string): Promise<void> {
    try {
      const accessToken = await getAccessToken(this.appId, this.clientSecret);

      // Parse media tags
      const mediaTagRegex = /<(qqimg|qqvoice|qqvideo|qqfile)>([^<>]+)<\/(?:qqimg|qqvoice|qqvideo|qqfile|img)>/gi;
      const mediaTagMatches = [...text.matchAll(mediaTagRegex)];

      if (mediaTagMatches.length > 0) {
        // Process media tags sequentially
        await this.sendMediaMessages(jid, text, accessToken, mediaTagMatches);
      } else {
        // Send plain text message (with auto-splitting)
        await this.sendTextMessage(jid, text, accessToken);
      }
    } catch (err) {
      logger.error({ jid, err }, 'QQ: Failed to send message');
    }
  }

  private async sendTextMessage(jid: string, text: string, accessToken: string, msgId?: string): Promise<void> {
    // Check reply limit
    let replyMsgId = msgId;
    if (msgId) {
      const { allowed, remaining } = checkMessageReplyLimit(msgId);
      if (!allowed) {
        logger.warn({ msgId, remaining }, 'QQ: Reply limit exceeded, sending as new message');
        replyMsgId = undefined; // Send as new message instead of reply
      }
    }

    // Split long messages
    if (text.length > MAX_MESSAGE_LENGTH) {
      logger.info({ jid, totalLength: text.length, parts: Math.ceil(text.length / MAX_MESSAGE_LENGTH) }, 'QQ: Splitting long message');
      for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
        const chunk = text.slice(i, i + MAX_MESSAGE_LENGTH);
        await this.doSendTextMessage(jid, chunk, accessToken, i === 0 ? replyMsgId : undefined);
      }
      return;
    }

    await this.doSendTextMessage(jid, text, accessToken, replyMsgId);
  }

  private async doSendTextMessage(jid: string, text: string, accessToken: string, msgId?: string): Promise<void> {
    const isGroup = jid.startsWith('qq:group:');
    const id = jid.replace(/^qq:(?:group:)?/, '');
    const seq = getMsgSeq(msgId);

    const body: Record<string, unknown> = {
      content: text,
      msg_type: 0,
      msg_seq: seq,
    };

    if (msgId) {
      body.msg_id = msgId;
    }

    const endpoint = isGroup
      ? `${API_BASE}/v2/groups/${id}/messages`
      : `${API_BASE}/v2/users/${id}/messages`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`QQ API error: ${response.status} ${errorText}`);
    }

    if (msgId) {
      recordMessageReply(msgId);
    }

    logger.info({ jid, length: text.length }, 'QQ: Message sent');
  }

  private async sendMediaMessages(
    jid: string,
    text: string,
    accessToken: string,
    matches: RegExpMatchArray[]
  ): Promise<void> {
    const isGroup = jid.startsWith('qq:group:');
    const id = jid.replace(/^qq:(?:group:)?/, '');

    let lastIndex = 0;
    const sendQueue: Array<{ type: 'text' | 'image' | 'voice' | 'video' | 'file'; content: string }> = [];

    for (const match of matches) {
      // Add text before this tag
      const textBefore = text.slice(lastIndex, match.index).replace(/\n{3,}/g, '\n\n').trim();
      if (textBefore) {
        sendQueue.push({ type: 'text', content: textBefore });
      }

      const tagName = match[1]!.toLowerCase();
      const mediaPath = match[2]?.trim() ?? '';
      if (mediaPath) {
        sendQueue.push({ type: tagName.replace('qq', '') as 'image' | 'voice' | 'video' | 'file', content: mediaPath });
      }

      lastIndex = (match.index ?? 0) + match[0].length;
    }

    // Add remaining text
    const remainingText = text.slice(lastIndex).replace(/\n{3,}/g, '\n\n').trim();
    if (remainingText) {
      sendQueue.push({ type: 'text', content: remainingText });
    }

    // Send each item
    for (const item of sendQueue) {
      try {
        if (item.type === 'text') {
          await this.sendTextMessage(jid, item.content, accessToken);
        } else {
          // Upload and send media
          await this.sendMediaMessage(jid, item.type, item.content, accessToken, isGroup, id);
        }
      } catch (err) {
        logger.error({ type: item.type, err }, 'QQ: Failed to send message part');
      }
    }
  }

  private async sendMediaMessage(
    _jid: string,
    mediaType: 'image' | 'voice' | 'video' | 'file',
    mediaPath: string,
    accessToken: string,
    isGroup: boolean,
    id: string
  ): Promise<void> {
    // Map media type to QQ file type
    const fileTypeMap: Record<string, number> = {
      image: 1,
      video: 2,
      voice: 3,
      file: 4,
    };

    const fileType = fileTypeMap[mediaType] ?? 1;
    const endpoint = isGroup
      ? `${API_BASE}/v2/groups/${id}/files`
      : `${API_BASE}/v2/users/${id}/files`;

    // Prepare request body
    const body: Record<string, unknown> = {
      file_type: fileType,
      srv_send_msg: true,
    };

    if (mediaPath.startsWith('http://') || mediaPath.startsWith('https://')) {
      body.url = mediaPath;
    } else {
      // Read local file and convert to base64
      const fileBuffer = await fs.promises.readFile(mediaPath);
      body.file_data = fileBuffer.toString('base64');
      if (mediaType === 'file') {
        body.file_name = path.basename(mediaPath);
      }
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `QQBot ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`QQ media upload error: ${response.status} ${errorText}`);
    }

    logger.info({ mediaType, isGroup }, 'QQ: Media message sent');
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qq:');
  }

  /**
   * Flush queued messages when connection is restored
   */
  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'QQ: Flushing outgoing queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sendMessageInternal(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Typing indicator - QQ Bot API doesn't support this
   */
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // QQ Bot API doesn't support typing indicator
  }

  async disconnect(): Promise<void> {
    this.isAborted = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.cleanup();
    logger.info('QQ: Disconnected');
  }
}

// Self-registration
registerChannel('qq', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['QQBOT_APP_ID', 'QQBOT_CLIENT_SECRET']);
  const appId = process.env.QQBOT_APP_ID || envVars.QQBOT_APP_ID || '';
  const clientSecret = process.env.QQBOT_CLIENT_SECRET || envVars.QQBOT_CLIENT_SECRET || '';

  if (!appId || !clientSecret) {
    logger.warn('QQ: QQBOT_APP_ID or QQBOT_CLIENT_SECRET not set');
    return null;
  }

  return new QQChannel(appId, clientSecret, opts);
});
