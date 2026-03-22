import { createClient, RedisClientType } from 'redis';

import {
  WEB_CHANNEL_ENABLED,
  WEB_CHANNEL_REDIS_URL,
} from '../config.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const JID_PREFIX = 'web:';
const MAIN_JID = 'web:main';
const INBOUND_QUEUE = 'nanoclaw:inbound';
const DEDUPE_PREFIX = 'nanoclaw:web:dedupe:';

type InboundPayload = {
  sessionId?: unknown;
  text?: unknown;
  userName?: unknown;
  messageId?: unknown;
  timestamp?: unknown;
};

export class WebChannel implements Channel {
  name = 'web';
  private client!: RedisClientType;
  private streamClient!: RedisClientType;
  private connected = false;
  private stopping = false;

  constructor(private opts: ChannelOpts) {}

  async connect(): Promise<void> {
    this.client = createClient({
      url: WEB_CHANNEL_REDIS_URL,
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 1000, 10000),
      },
    });
    this.streamClient = this.client.duplicate();

    this.client.on('error', (err) => {
      logger.error({ err }, 'Web channel Redis error');
    });
    this.streamClient.on('error', (err) => {
      logger.error({ err }, 'Web channel stream Redis error');
    });

    await Promise.all([this.client.connect(), this.streamClient.connect()]);

    this.connected = true;
    logger.info('Web channel connected to Redis');
    void this.pollInbound();
  }

  private async pollInbound(): Promise<void> {
    while (!this.stopping && this.connected) {
      try {
        const result = await this.client.brPop(INBOUND_QUEUE, 0);
        if (!result) continue;

        let payload: InboundPayload;
        try {
          payload = JSON.parse(result.element) as InboundPayload;
        } catch {
          logger.warn(
            { elementPreview: result.element.slice(0, 120) },
            'Web channel dropping malformed JSON payload',
          );
          continue;
        }

        const sessionId =
          typeof payload.sessionId === 'string' ? payload.sessionId : '';
        const text = typeof payload.text === 'string' ? payload.text : '';
        const messageId =
          typeof payload.messageId === 'string' ? payload.messageId : '';
        const userName =
          typeof payload.userName === 'string' ? payload.userName : 'Web User';

        if (!sessionId || !text || !messageId) {
          logger.warn(
            { payload },
            'Web channel dropping payload missing required fields',
          );
          continue;
        }

        // v1 scope: only web:main is supported for deterministic trust setup.
        if (sessionId !== 'main') {
          logger.warn({ sessionId }, 'Web channel dropping unsupported session');
          continue;
        }

        const dedupeKey = `${DEDUPE_PREFIX}${messageId}`;
        const wasNew = await this.client.set(dedupeKey, '1', {
          NX: true,
          EX: 3600,
        });
        if (!wasNew) {
          logger.debug({ messageId }, 'Web channel dropping duplicate message');
          continue;
        }

        const msgTimestamp = this.toIsoTimestamp(payload.timestamp);
        this.opts.onMessage(MAIN_JID, {
          id: `web-${messageId}`,
          chat_jid: MAIN_JID,
          sender: sessionId,
          sender_name: userName,
          content: text,
          timestamp: msgTimestamp,
        });
        this.opts.onChatMetadata(
          MAIN_JID,
          msgTimestamp,
          'Web Main',
          'web',
          false,
        );
      } catch (err) {
        if (this.stopping) break;
        logger.error({ err }, 'Web channel poll error; retrying in 5s');
        await this.sleep(5000);
      }
    }
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn('Web channel send attempted while disconnected');
      return;
    }

    const streamKey = 'nanoclaw:outbound:main';
    await this.streamClient.xAdd(streamKey, '*', {
      type: 'message',
      text,
      timestamp: Date.now().toString(),
    });
    await this.streamClient.xTrim(streamKey, 'MAXLEN', '~', 1000);
  }

  async setTyping(_jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;
    const streamKey = 'nanoclaw:outbound:main';
    await this.streamClient.xAdd(streamKey, '*', {
      type: 'typing',
      isTyping: isTyping ? 'true' : 'false',
      timestamp: Date.now().toString(),
    });
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  isConnected(): boolean {
    return this.connected && this.client?.isOpen === true;
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    this.connected = false;
    await this.client?.disconnect().catch(() => undefined);
    await this.streamClient?.disconnect().catch(() => undefined);
    logger.info('Web channel disconnected');
  }

  private toIsoTimestamp(raw: unknown): string {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return new Date(raw).toISOString();
    }
    if (typeof raw === 'string') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
      const asDate = new Date(raw);
      if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();
    }
    return new Date().toISOString();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

registerChannel('web', (opts: ChannelOpts) => {
  if (!WEB_CHANNEL_ENABLED) return null;
  if (!WEB_CHANNEL_REDIS_URL) {
    logger.warn('Web channel enabled but WEB_CHANNEL_REDIS_URL is missing');
    return null;
  }
  return new WebChannel(opts);
});
