/**
 * Feishu (Lark) Channel for NanoClaw
 * Supports both Feishu (China) and Lark (International) platforms
 *
 * Uses official @larksuiteoapi/node-sdk for WebSocket event handling
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { readEnvFile } from '../env.js';
import { registerChannel, ChannelOpts } from './registry.js';

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client!: lark.Client;
  private connected = false;
  private botOpenId: string | undefined;
  private opts: ChannelOpts;
  private appId: string;
  private appSecret: string;
  private domain: lark.Domain;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
    const env = readEnvFile([
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
      'FEISHU_PLATFORM',
    ]);
    this.appId = env.FEISHU_APP_ID || '';
    this.appSecret = env.FEISHU_APP_SECRET || '';
    this.domain =
      env.FEISHU_PLATFORM === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
  }

  async connect(): Promise<void> {
    const { appId, appSecret, domain } = this;

    this.client = new lark.Client({ appId, appSecret, domain });

    // Fetch bot's own open_id so we can detect our own messages
    try {
      const resp = await this.client.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      });
      this.botOpenId = (resp as any)?.bot?.open_id;
      logger.info({ botOpenId: this.botOpenId }, 'Feishu bot info fetched');
    } catch (err) {
      logger.warn(
        { err },
        'Failed to fetch Feishu bot info, bot message detection may not work',
      );
    }

    const wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain,
      loggerLevel: lark.LoggerLevel.warn,
    });

    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
    });

    wsClient.start({ eventDispatcher });
    this.connected = true;
    logger.info({ domain }, 'Connected to Feishu via WebSocket');
  }

  private async handleMessage(data: any): Promise<void> {
    // SDK may pass data as {event: {message, sender}} or directly as {message, sender}
    const msg = data?.message || data?.event?.message;
    const sender = data?.sender || data?.event?.sender;
    if (!msg) return;

    // Skip bot's own messages
    if (
      sender?.sender_id?.open_id &&
      sender.sender_id.open_id === this.botOpenId
    )
      return;

    const chatId = msg.chat_id;
    if (!chatId) return;

    // Only handle text messages
    if (msg.message_type !== 'text') return;

    let content = '';
    try {
      const parsed = JSON.parse(msg.content || '{}');
      content = parsed.text || '';
    } catch {
      return;
    }
    if (!content) return;

    const chatJid = `${chatId}@feishu`;
    const timestamp = new Date(Number(msg.create_time)).toISOString();
    const senderName = sender?.sender_id?.open_id || 'unknown';

    // Notify chat metadata
    const isGroup = msg.chat_type === 'group';
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

    // Deliver message only if this chat is registered
    const groups = this.opts.registeredGroups();
    if (groups[chatJid]) {
      this.opts.onMessage(chatJid, {
        id: msg.message_id || '',
        chat_jid: chatJid,
        sender: sender?.sender_id?.open_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace(/@feishu$/, '');
    const prefixed = `${ASSISTANT_NAME}: ${text}`;
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: prefixed }),
        },
      });
      logger.info({ jid, length: prefixed.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@feishu');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}

// Auto-register the channel if credentials are configured
export function createFeishuChannel(opts: ChannelOpts): Channel | null {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    logger.warn(
      { hasId: !!env.FEISHU_APP_ID, hasSecret: !!env.FEISHU_APP_SECRET },
      'Feishu channel credentials missing — skipping',
    );
    return null;
  }

  try {
    const channel = new FeishuChannel(opts);
    logger.info('Feishu channel created successfully');
    return channel;
  } catch (error) {
    logger.warn({ error }, 'Feishu channel not enabled (constructor error)');
    return null;
  }
}

// Self-register with the channel registry
registerChannel('feishu', createFeishuChannel);
