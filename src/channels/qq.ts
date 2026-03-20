import axios from 'axios';
import WebSocket from 'ws';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { ChannelOpts, registerChannel } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';

// Intents: GROUP_AT_MESSAGE_CREATE (1<<25) | C2C_MESSAGE_CREATE (1<<28)
const INTENTS = (1 << 25) | (1 << 28);

// WebSocket OpCodes
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export interface QQBotChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
}

export class QQBotChannel implements Channel {
  name = 'qq';

  private appId: string;
  private appSecret: string;
  private opts: QQBotChannelOpts;

  private accessToken = '';
  private tokenExpiresAt = 0;

  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sessionId = '';
  private lastSeq: number | null = null;
  private connected = false;

  // Dedup: track recently seen message IDs
  private recentMsgIds = new Set<string>();

  // Track last message/event ID per chat for passive replies
  private lastMsgId = new Map<string, string>();
  private lastEventId = new Map<string, string>();

  constructor(appId: string, appSecret: string, opts: QQBotChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
  }

  // ── Token management ──────────────────────────────────────────────────────

  private async fetchToken(): Promise<void> {
    const res = await axios.post(TOKEN_URL, {
      appId: this.appId,
      clientSecret: this.appSecret,
    });
    this.accessToken = res.data.access_token;
    // Refresh 60s before expiry
    this.tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
    logger.info('QQ Bot access token refreshed');
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      await this.fetchToken();
    }
  }

  private authHeader(): string {
    return `QQBot ${this.accessToken}`;
  }

  // ── WebSocket connection ──────────────────────────────────────────────────

  async connect(): Promise<void> {
    await this.fetchToken();

    const gwRes = await axios.get(`${API_BASE}/gateway`, {
      headers: { Authorization: this.authHeader() },
    });
    const gatewayUrl: string = gwRes.data.url;

    this.openWebSocket(gatewayUrl);
  }

  private openWebSocket(url: string): void {
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('QQ Bot WebSocket connected');
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      let payload: any;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handlePayload(payload);
    });

    this.ws.on('close', (code: number, _reason: Buffer) => {
      this.connected = false;
      this.clearHeartbeat();
      logger.warn({ code }, 'QQ Bot WebSocket closed, reconnecting in 5s');
      setTimeout(() => this.reconnect(), 5000);
    });

    this.ws.on('error', (err: Error) => {
      logger.error({ err }, 'QQ Bot WebSocket error');
    });
  }

  private async reconnect(): Promise<void> {
    try {
      await this.ensureToken();
      const gwRes = await axios.get(`${API_BASE}/gateway`, {
        headers: { Authorization: this.authHeader() },
      });
      this.openWebSocket(gwRes.data.url);
    } catch (err) {
      logger.error({ err }, 'QQ Bot reconnect failed, retrying in 10s');
      setTimeout(() => this.reconnect(), 10000);
    }
  }

  private handlePayload(payload: any): void {
    const { op, d, s, t } = payload;

    if (s != null) this.lastSeq = s;

    switch (op) {
      case OP_HELLO:
        this.startHeartbeat(d.heartbeat_interval);
        if (this.sessionId && this.lastSeq != null) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        break;

      case OP_HEARTBEAT_ACK:
        logger.debug('QQ Bot heartbeat ACK');
        break;

      case OP_DISPATCH:
        if (t === 'READY') {
          this.sessionId = d.session_id;
          this.connected = true;
          logger.info({ sessionId: this.sessionId }, 'QQ Bot ready');
          console.log('\n  QQ Bot connected');
          console.log(
            '  Any new chat will be auto-registered on first message\n',
          );
        } else if (t === 'RESUMED') {
          this.connected = true;
          logger.info('QQ Bot session resumed');
        } else if (t === 'GROUP_AT_MESSAGE_CREATE') {
          this.handleGroupMessage(d).catch((err) =>
            logger.error({ err }, 'QQ group message error'),
          );
        } else if (t === 'C2C_MESSAGE_CREATE') {
          this.handleC2CMessage(d).catch((err) =>
            logger.error({ err }, 'QQ C2C message error'),
          );
        }
        break;

      default:
        break;
    }
  }

  private sendIdentify(): void {
    this.send({
      op: OP_IDENTIFY,
      d: {
        token: this.authHeader(),
        intents: INTENTS,
        shard: [0, 1],
        properties: { $os: 'linux', $browser: 'nanoclaw', $device: 'nanoclaw' },
      },
    });
  }

  private sendResume(): void {
    this.send({
      op: OP_RESUME,
      d: {
        token: this.authHeader(),
        session_id: this.sessionId,
        seq: this.lastSeq,
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: OP_HEARTBEAT, d: this.lastSeq });
    }, intervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // ── Message handlers ──────────────────────────────────────────────────────

  private async handleGroupMessage(d: any): Promise<void> {
    const msgId: string = d.id;
    const groupOpenId: string = d.group_openid;
    const memberOpenId: string = d.author?.member_openid || '';
    const content: string = (d.content || '').trim();
    const timestamp: string = d.timestamp || new Date().toISOString();

    if (!groupOpenId) return;
    if (this.deduplicate(msgId)) return;

    const chatJid = `qq:group:${groupOpenId}`;
    this.lastMsgId.set(chatJid, msgId);
    this.lastEventId.set(chatJid, d.event_id || '');

    this.opts.onChatMetadata(chatJid, timestamp, groupOpenId, 'qq', true);

    // Strip @bot mention prefix, add trigger if needed
    let text = content.replace(/^@\S+\s*/, '').trim();
    if (!TRIGGER_PATTERN.test(text)) {
      text = `@${ASSISTANT_NAME} ${text}`;
    }

    let group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      if (!this.opts.registerGroup) {
        logger.debug({ chatJid }, 'QQ group not registered');
        return;
      }
      // Auto-register on first message
      const folder = `qq_group-${groupOpenId.slice(0, 8).toLowerCase()}`;
      group = {
        name: `QQ Group ${groupOpenId.slice(0, 8)}`,
        folder,
        trigger: ASSISTANT_NAME,
        added_at: timestamp,
        requiresTrigger: true,
      };
      this.opts.registerGroup(chatJid, group);
      logger.info({ chatJid, folder }, 'QQ group auto-registered');
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: memberOpenId,
      sender_name: memberOpenId,
      content: text,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: memberOpenId }, 'QQ group message stored');
  }

  private async handleC2CMessage(d: any): Promise<void> {
    const msgId: string = d.id;
    const userOpenId: string = d.author?.user_openid || '';
    const content: string = (d.content || '').trim();
    const timestamp: string = d.timestamp || new Date().toISOString();

    if (!userOpenId) return;
    if (this.deduplicate(msgId)) return;

    const chatJid = `qq:user:${userOpenId}`;
    this.lastMsgId.set(chatJid, msgId);
    this.lastEventId.set(chatJid, d.event_id || '');

    this.opts.onChatMetadata(chatJid, timestamp, userOpenId, 'qq', false);

    let text = content.trim();
    if (!TRIGGER_PATTERN.test(text)) {
      text = `@${ASSISTANT_NAME} ${text}`;
    }

    let group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      if (!this.opts.registerGroup) {
        logger.debug({ chatJid }, 'QQ C2C not registered');
        return;
      }
      // Auto-register on first message
      const folder = `qq_user-${userOpenId.slice(0, 8).toLowerCase()}`;
      group = {
        name: `QQ User ${userOpenId.slice(0, 8)}`,
        folder,
        trigger: ASSISTANT_NAME,
        added_at: timestamp,
        requiresTrigger: false,
      };
      this.opts.registerGroup(chatJid, group);
      logger.info({ chatJid, folder }, 'QQ C2C auto-registered');
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: userOpenId,
      sender_name: userOpenId,
      content: text,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: userOpenId }, 'QQ C2C message stored');
  }

  private deduplicate(msgId: string): boolean {
    if (!msgId) return false;
    if (this.recentMsgIds.has(msgId)) return true;
    this.recentMsgIds.add(msgId);
    setTimeout(() => this.recentMsgIds.delete(msgId), 10_000);
    return false;
  }

  // ── Send message ──────────────────────────────────────────────────────────

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      await this.ensureToken();

      const msgId = this.lastMsgId.get(jid);
      const eventId = this.lastEventId.get(jid);

      const body: Record<string, any> = {
        content: text,
        msg_type: 0,
      };

      // Include passive reply IDs to bypass active message limits
      if (msgId) body.msg_id = msgId;
      if (eventId) body.event_id = eventId;

      let url: string;
      if (jid.startsWith('qq:group:')) {
        const groupOpenId = jid.replace('qq:group:', '');
        url = `${API_BASE}/v2/groups/${groupOpenId}/messages`;
      } else if (jid.startsWith('qq:user:')) {
        const userOpenId = jid.replace('qq:user:', '');
        url = `${API_BASE}/v2/users/${userOpenId}/messages`;
      } else {
        logger.warn({ jid }, 'QQ sendMessage: unknown JID format');
        return;
      }

      await axios.post(url, body, {
        headers: { Authorization: this.authHeader() },
      });

      logger.info({ jid, length: text.length }, 'QQ message sent');
    } catch (err: any) {
      logger.error(
        { jid, err: err?.response?.data || err?.message },
        'Failed to send QQ message',
      );
    }
  }

  // ── Channel interface ─────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qq:');
  }

  async disconnect(): Promise<void> {
    this.clearHeartbeat();
    this.connected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('QQ Bot disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // QQ Bot API does not support typing indicators
  }
}

registerChannel('qq', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['QQ_BOT_APP_ID', 'QQ_BOT_APP_SECRET']);
  const appId = process.env.QQ_BOT_APP_ID || envVars.QQ_BOT_APP_ID || '';
  const appSecret =
    process.env.QQ_BOT_APP_SECRET || envVars.QQ_BOT_APP_SECRET || '';
  if (!appId || !appSecret) {
    logger.warn('QQ Bot: QQ_BOT_APP_ID or QQ_BOT_APP_SECRET not set, skipping');
    return null;
  }
  return new QQBotChannel(appId, appSecret, opts);
});
