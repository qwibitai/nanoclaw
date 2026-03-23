import WebSocket from 'ws';
import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface QQBotChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface AccessTokenResponse {
  access_token: string;
  expires_in: number | string;
}

interface GatewayResponse {
  url: string;
}

interface MessagePayload {
  op: number;
  d?: any;
  s?: number;
  t?: string;
}

interface C2CMessageEvent {
  author: {
    id: string;
    user_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
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
}

// QQ Bot intents
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  DIRECT_MESSAGE: 1 << 12,
  AUDIO_OR_LIVE_CHANNEL_MEMBER: 1 << 19,
};

export class QQBotChannel implements Channel {
  name = 'qqbot';

  private appId: string;
  private clientSecret: string;
  private opts: QQBotChannelOpts;
  private ws: WebSocket | null = null;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private connected = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  private isConnecting = false;

  constructor(appId: string, clientSecret: string, opts: QQBotChannelOpts) {
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.isConnecting || this.ws) {
      logger.debug('QQ Bot already connecting or connected');
      return;
    }

    this.isConnecting = true;
    try {
      logger.info('QQ Bot channel connecting...');
      await this.getAccessToken();
      logger.info('QQ Bot access token obtained');
      const gatewayUrl = await this.getGatewayUrl();
      logger.info({ gatewayUrl }, 'QQ Bot gateway URL obtained');
      await this.connectWebSocket(gatewayUrl);
    } catch (err) {
      logger.error({ err }, 'Failed to connect QQ Bot channel');
      throw err;
    } finally {
      this.isConnecting = false;
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const savedProxy = process.env.HTTPS_PROXY;
    delete process.env.HTTPS_PROXY;

    try {
      const response = await fetch('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: this.appId,
          clientSecret: this.clientSecret,
        }),
      });

      if (savedProxy) process.env.HTTPS_PROXY = savedProxy;

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Token request failed: ${response.statusText} - ${body}`);
      }

      const data = await response.json() as AccessTokenResponse;
      this.accessToken = data.access_token;
      const expiresIn = typeof data.expires_in === 'string' 
        ? parseInt(data.expires_in, 10) 
        : data.expires_in;
      this.tokenExpiry = Date.now() + (expiresIn - 60) * 1000;
      
      logger.info('QQ Bot access token obtained');
      return this.accessToken;
    } catch (err) {
      if (savedProxy) process.env.HTTPS_PROXY = savedProxy;
      logger.error({ err }, 'Failed to get QQ Bot access token');
      throw err;
    }
  }

  private async getGatewayUrl(): Promise<string> {
    const token = await this.getAccessToken();
    
    const savedProxy = process.env.HTTPS_PROXY;
    delete process.env.HTTPS_PROXY;

    try {
      const response = await fetch('https://api.sgroup.qq.com/gateway', {
        method: 'GET',
        headers: { Authorization: `QQBot ${token}` },
      });

      if (savedProxy) process.env.HTTPS_PROXY = savedProxy;

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Gateway request failed: ${response.statusText} - ${body}`);
      }

      const data = await response.json() as GatewayResponse;
      return data.url;
    } catch (err) {
      if (savedProxy) process.env.HTTPS_PROXY = savedProxy;
      logger.error({ err }, 'Failed to get QQ Bot gateway URL');
      throw err;
    }
  }

  private async connectWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        logger.info('QQ Bot WebSocket connected');
        this.connected = true;
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const payload = JSON.parse(data.toString()) as MessagePayload;
          this.handleMessage(payload);
        } catch (err) {
          logger.error({ err }, 'Failed to parse QQ Bot message');
        }
      });

      this.ws.on('error', (err) => {
        logger.error({ err }, 'QQ Bot WebSocket error');
        if (!this.connected) reject(err);
      });

      this.ws.on('close', (code, reason) => {
        logger.warn({ code, reason: reason.toString() }, 'QQ Bot WebSocket closed');
        this.cleanup();
        this.scheduleReconnect();
      });
    });
  }

  private handleMessage(payload: MessagePayload): void {
    switch (payload.op) {
      case 10: // Hello
        this.handleHello(payload);
        break;
      case 0: // Dispatch
        if (payload.s !== undefined) {
          this.sessionId = String(payload.s);
        }
        this.handleDispatch(payload);
        break;
      case 11: // Heartbeat ACK
        logger.debug('QQ Bot heartbeat ACK');
        break;
      case 9: // Invalid Session
        logger.warn('QQ Bot invalid session, reconnecting');
        this.sessionId = null;
        this.reconnect();
        break;
      default:
        logger.debug({ op: payload.op }, 'Unknown QQ Bot opcode');
    }
  }

  private handleHello(payload: MessagePayload): void {
    const heartbeatInterval = payload.d?.heartbeat_interval || 41250;
    logger.info({ heartbeatInterval }, 'QQ Bot starting heartbeat');

    // Send Identify
    const intents =
      INTENTS.GUILDS |
      INTENTS.GUILD_MEMBERS |
      INTENTS.PUBLIC_GUILD_MESSAGES |
      INTENTS.GROUP_AND_C2C_EVENT |
      INTENTS.DIRECT_MESSAGE;

    this.sendPayload({
      op: 2,
      d: {
        token: `QQBot ${this.accessToken}`,
        intents,
        shard: [0, 1],
        properties: {
          $os: 'linux',
          $browser: 'nanoclaw',
          $device: 'nanoclaw',
        },
      },
    });

    // Start heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    this.heartbeatInterval = setInterval(() => {
      this.sendPayload({ op: 1, d: null });
    }, heartbeatInterval);
  }

  private sendPayload(payload: MessagePayload): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private handleDispatch(payload: MessagePayload): void {
    const eventType = payload.t;
    const eventData = payload.d;

    switch (eventType) {
      case 'READY':
        logger.info({ user: eventData?.user }, 'QQ Bot ready');
        break;
      case 'C2C_MESSAGE_CREATE':
        this.handleC2CMessage(eventData as C2CMessageEvent);
        break;
      case 'GROUP_AT_MESSAGE_CREATE':
        this.handleGroupMessage(eventData as GroupMessageEvent);
        break;
      default:
        logger.debug({ eventType }, 'Unhandled QQ Bot event');
    }
  }

  private handleC2CMessage(event: C2CMessageEvent): void {
    const chatJid = `qqbot:c2c:${event.author.user_openid}`;
    const content = event.content.trim();
    const timestamp = event.timestamp;
    const senderName = event.author.user_openid;
    const sender = event.author.id;
    const msgId = event.id;

    this.opts.onChatMetadata(chatJid, timestamp, senderName, 'qqbot', false);

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered QQ C2C chat');
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: senderName }, 'QQ C2C message stored');
  }

  private handleGroupMessage(event: GroupMessageEvent): void {
    const chatJid = `qqbot:group:${event.group_openid}`;
    let content = event.content.trim();
    const timestamp = event.timestamp;
    const senderName = event.author.member_openid;
    const sender = event.author.id;
    const msgId = event.id;

    this.opts.onChatMetadata(chatJid, timestamp, event.group_openid, 'qqbot', true);

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered QQ group');
      return;
    }

    // Add trigger if not present
    if (!TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: senderName }, 'QQ group message stored');
  }

  private cleanup(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws = null;
    }
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    this.reconnectTimeout = setTimeout(() => {
      logger.info('Attempting to reconnect QQ Bot');
      this.reconnect();
    }, 5000);
  }

  private reconnect(): void {
    this.cleanup();
    this.connect().catch((err) => {
      logger.error({ err }, 'Failed to reconnect QQ Bot');
      this.scheduleReconnect();
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    await this.getAccessToken();

    try {
      const parts = jid.split(':');
      if (parts.length !== 3 || parts[0] !== 'qqbot') {
        throw new Error(`Invalid QQ JID format: ${jid}`);
      }

      const [, type, openid] = parts;
      const MAX_LENGTH = 4000;
      const chunks = text.length <= MAX_LENGTH ? [text] : this.splitText(text, MAX_LENGTH);

      for (const chunk of chunks) {
        if (type === 'c2c') {
          await this.sendC2CMessage(openid, chunk);
        } else if (type === 'group') {
          await this.sendGroupMessage(openid, chunk);
        } else {
          throw new Error(`Unknown QQ chat type: ${type}`);
        }
      }

      logger.info({ jid, length: text.length }, 'QQ message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send QQ message');
    }
  }

  private splitText(text: string, limit: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining);
        break;
      }

      let splitAt = remaining.lastIndexOf('\n', limit);
      if (splitAt <= 0 || splitAt < limit * 0.5) {
        splitAt = remaining.lastIndexOf(' ', limit);
      }
      if (splitAt <= 0 || splitAt < limit * 0.5) {
        splitAt = limit;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
  }

  private async sendC2CMessage(openid: string, content: string): Promise<void> {
    const savedProxy = process.env.HTTPS_PROXY;
    delete process.env.HTTPS_PROXY;

    try {
      const response = await fetch(`https://api.sgroup.qq.com/v2/users/${openid}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `QQBot ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          msg_type: 0,
        }),
      });

      if (savedProxy) process.env.HTTPS_PROXY = savedProxy;

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`C2C send failed: ${response.statusText} - ${error}`);
      }
    } catch (err) {
      if (savedProxy) process.env.HTTPS_PROXY = savedProxy;
      throw err;
    }
  }

  private async sendGroupMessage(openid: string, content: string): Promise<void> {
    const savedProxy = process.env.HTTPS_PROXY;
    delete process.env.HTTPS_PROXY;

    try {
      const response = await fetch(`https://api.sgroup.qq.com/v2/groups/${openid}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `QQBot ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content,
          msg_type: 0,
        }),
      });

      if (savedProxy) process.env.HTTPS_PROXY = savedProxy;

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Group send failed: ${response.statusText} - ${error}`);
      }
    } catch (err) {
      if (savedProxy) process.env.HTTPS_PROXY = savedProxy;
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qqbot:');
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('QQ Bot disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // QQ Bot API doesn't support typing indicators
  }
}
