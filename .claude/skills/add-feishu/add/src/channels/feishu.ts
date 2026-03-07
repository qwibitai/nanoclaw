import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

const MAX_MESSAGE_BYTES = 4000;

function splitMessage(text: string): string[] {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  let current = '';
  for (const char of text) {
    const next = current + char;
    if (encoder.encode(next).length > MAX_MESSAGE_BYTES) {
      chunks.push(current);
      current = char;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function parseJid(jid: string): {
  receiveId: string;
  receiveIdType: 'chat_id' | 'open_id';
} {
  if (jid.startsWith('fs:p_')) {
    return { receiveId: jid.slice('fs:p_'.length), receiveIdType: 'open_id' };
  }
  return { receiveId: jid.slice('fs:'.length), receiveIdType: 'chat_id' };
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;
  private botOpenId: string | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    // Fetch bot's own open_id so we can detect @mentions in group chats
    try {
      const res = await (this.client as any).bot.v3.botInfo.get();
      this.botOpenId = res?.data?.bot?.open_id ?? null;
      logger.info({ botOpenId: this.botOpenId }, 'Feishu bot connected');
    } catch (err) {
      logger.warn({ err }, 'Feishu: could not fetch bot info');
    }

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    this.wsClient.start({ eventDispatcher });
    console.log(`\n  Feishu bot connected (WebSocket mode)\n`);
  }

  private async handleMessage(data: any): Promise<void> {
    const { message, sender } = data;
    if (!message || !sender) return;

    const chatId: string = message.chat_id ?? '';
    const chatType: string = message.chat_type ?? 'p2p';
    const openId: string = sender?.sender_id?.open_id ?? '';
    const msgId: string = message.message_id ?? '';

    // Feishu create_time is a Unix timestamp in milliseconds as a string
    const createTimeMs = parseInt(message.create_time ?? '0', 10);
    const timestamp = new Date(createTimeMs).toISOString();

    // Build JID: p2p uses open_id, group uses chat_id
    const jid = chatType === 'p2p' ? `fs:p_${openId}` : `fs:${chatId}`;

    // Parse text content — Feishu content is a JSON string
    let content = '';
    try {
      const parsed = JSON.parse(message.content ?? '{}');
      content = parsed.text ?? '';
    } catch {
      logger.debug({ msgId }, 'Feishu: non-text message ignored');
      return;
    }

    // Normalise @bot mention to TRIGGER_PATTERN format
    const mentions: Array<{ id?: { open_id?: string } }> =
      message.mentions ?? [];
    const isBotMentioned =
      this.botOpenId !== null &&
      mentions.some((m) => m.id?.open_id === this.botOpenId);

    if (isBotMentioned) {
      // Strip <at user_id="...">Name</at> XML tags left in the content
      content = content.replace(/<at[^>]*>.*?<\/at>/g, '').trim();
      if (!TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`.trim();
      }
    }

    const isGroup = chatType === 'group';
    const chatName = isGroup ? chatId : openId;

    this.opts.onChatMetadata(jid, timestamp, chatName, 'feishu', isGroup);

    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      logger.debug({ jid, chatName }, 'Feishu message from unregistered chat');
      return;
    }

    if (group.requiresTrigger && !TRIGGER_PATTERN.test(content)) {
      logger.debug({ jid }, 'Feishu group message ignored (no trigger)');
      return;
    }

    this.opts.onMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender: openId,
      sender_name: openId,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ jid, chatName, sender: openId }, 'Feishu message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }

    const { receiveId, receiveIdType } = parseJid(jid);
    try {
      const chunks = splitMessage(text);
      for (const chunk of chunks) {
        await this.client.im.message.create({
          data: {
            receive_id: receiveId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          },
          params: { receive_id_type: receiveIdType },
        });
      }
      logger.info({ jid, chunks: chunks.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  isConnected(): boolean {
    return this.wsClient !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('fs:');
  }

  async disconnect(): Promise<void> {
    this.wsClient = null;
    this.client = null;
    logger.info('Feishu bot stopped');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu has no standalone typing indicator API
  }
}

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';
  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
    return null;
  }
  return new FeishuChannel(appId, appSecret, opts);
});
