import * as lark from '@larksuiteoapi/node-sdk';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';

import { registerChannel, ChannelOpts } from './registry.js';

// ---- 配置 ----

const JID_PREFIX = 'fs:';
const TYPING_EMOJI = 'OnIt'; // 飞书内置 emoji key
const CARD_THRESHOLD = 500;
const MD_PATTERN = /```|^##\s|^\|.*\|/m;
const PROGRESS_EMOJI_PATTERN = /^[🔧📖✏️🔍🌐📋⚙️]/;

// ---- 工具函数 ----

/** 从 JID 提取飞书 chat_id */
function chatIdFromJid(jid: string): string {
  return jid.slice(JID_PREFIX.length);
}

/** 判断文本是否应该用卡片发送 */
function shouldUseCard(text: string): boolean {
  return text.length > CARD_THRESHOLD || MD_PATTERN.test(text);
}

/** 构建飞书交互卡片 JSON */
function buildCard(
  text: string,
  headerText?: string,
  headerColor?: string,
): string {
  const card: Record<string, unknown> = {
    elements: [{ tag: 'markdown', content: text }],
  };
  // 只有明确传了标题才显示 header（进度卡片等），正式回复不带标题栏
  if (headerText) {
    card.header = {
      template: headerColor || 'blue',
      title: { tag: 'plain_text', content: headerText },
    };
  }
  return JSON.stringify(card);
}

/** 构建进度卡片（黄色标题 + 步骤列表） */
function buildProgressCard(steps: string[]): string {
  const content = steps.join('\n');
  return buildCard(content, '⏳ 处理中...', 'yellow');
}

// ---- 飞书 Channel 实现 ----

export class FeishuChannel implements Channel {
  readonly name = 'feishu';

  private client: lark.Client;
  private ws: lark.WSClient | null = null;
  private connected = false;
  private opts: ChannelOpts;
  private appId: string;
  private appSecret: string;

  // 记录 jid → { messageId, reactionId }，用于移除 typing indicator
  private typingReactions = new Map<
    string,
    { messageId: string; reactionId: string }
  >();

  // 进度卡片状态：每个 chat 一张进度卡片，持续更新
  private progressCards = new Map<
    string,
    { messageId: string; steps: string[] }
  >();

  constructor(appId: string, appSecret: string, opts: ChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
    this.client = new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    });
  }

  // ---- Channel 接口 ----

  async connect(): Promise<void> {
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => {
        this.handleMessage(data);
      },
    });

    this.ws = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      eventDispatcher: dispatcher,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
    } as ConstructorParameters<typeof lark.WSClient>[0]);

    await (
      this.ws as unknown as {
        start(p: { eventDispatcher: lark.EventDispatcher }): Promise<void>;
      }
    ).start({ eventDispatcher: dispatcher });
    this.connected = true;
    logger.info('飞书 WebSocket 已连接');
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    logger.info('飞书 WebSocket 已断开');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = chatIdFromJid(jid);

    // ---- 进度消息聚合 ----
    // 如果是进度消息（工具调用 emoji 开头），聚合到同一张卡片
    if (PROGRESS_EMOJI_PATTERN.test(text)) {
      try {
        const existing = this.progressCards.get(jid);
        if (existing) {
          // 更新已有进度卡片
          existing.steps.push(text);
          // 只保留最近 8 条进度
          if (existing.steps.length > 8) existing.steps.shift();
          await this.client.im.message.patch({
            path: { message_id: existing.messageId },
            data: {
              content: buildProgressCard(existing.steps),
            },
          });
          logger.debug(
            { jid, steps: existing.steps.length },
            '飞书进度卡片已更新',
          );
        } else {
          // 创建新进度卡片
          const resp = await this.client.im.message.create({
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: buildProgressCard([text]),
            },
            params: { receive_id_type: 'chat_id' },
          });
          const msgId = resp?.data?.message_id;
          if (msgId) {
            this.progressCards.set(jid, { messageId: msgId, steps: [text] });
            logger.debug({ jid, messageId: msgId }, '飞书进度卡片已创建');
          }
        }
      } catch (err) {
        logger.debug({ err }, '飞书进度卡片操作失败（非致命，降级为普通消息）');
        // 降级：发普通消息
        await this.sendPlainOrCard(chatId, text);
      }
      return;
    }

    // ---- 正式回复：进度卡片标题改为「✅ 已完成」----
    const progressEntry = this.progressCards.get(jid);
    if (progressEntry) {
      this.progressCards.delete(jid);
      try {
        await this.client.im.message.patch({
          path: { message_id: progressEntry.messageId },
          data: {
            content: JSON.stringify({
              elements: [
                { tag: 'markdown', content: progressEntry.steps.join('\n') },
              ],
              header: {
                template: 'green',
                title: { tag: 'plain_text', content: '✅ 已完成' },
              },
            }),
          },
        });
        logger.debug(
          { jid, messageId: progressEntry.messageId },
          '飞书进度卡片已标记完成',
        );
      } catch (err) {
        logger.debug({ err }, '飞书进度卡片更新失败（非致命）');
      }
    }

    try {
      await this.sendPlainOrCard(chatId, text);
    } catch (err) {
      logger.error({ err }, '飞书发送消息失败');
      throw err;
    }
  }

  /** 发送纯文本或卡片消息（内部方法） */
  private async sendPlainOrCard(chatId: string, text: string): Promise<void> {
    if (shouldUseCard(text)) {
      await this.client.im.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: buildCard(text),
        },
        params: { receive_id_type: 'chat_id' },
      });
    } else {
      await this.client.im.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
        params: { receive_id_type: 'chat_id' },
      });
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      if (isTyping) {
        const lastMsgId = this.getLastMessageId(jid);
        if (!lastMsgId) {
          logger.info({ jid }, '飞书 setTyping(true): 无 lastMsgId，跳过');
          return;
        }
        logger.info({ jid, lastMsgId }, '飞书 setTyping(true): 添加 reaction');
        const resp = await this.client.im.messageReaction.create({
          data: { reaction_type: { emoji_type: TYPING_EMOJI } },
          path: { message_id: lastMsgId },
        });
        const reactionId = resp?.data?.reaction_id;
        if (reactionId) {
          this.typingReactions.set(jid, { messageId: lastMsgId, reactionId });
          logger.info(
            { jid, lastMsgId, reactionId },
            '飞书 setTyping(true): reaction 已保存',
          );
        } else {
          logger.info(
            { jid, resp: JSON.stringify(resp?.data) },
            '飞书 setTyping(true): 未获得 reactionId',
          );
        }
      } else {
        const entry = this.typingReactions.get(jid);
        logger.info(
          {
            jid,
            hasEntry: !!entry,
            entry: entry ? JSON.stringify(entry) : null,
          },
          '飞书 setTyping(false): 移除 reaction',
        );
        if (entry) {
          await this.client.im.messageReaction.delete({
            path: {
              message_id: entry.messageId,
              reaction_id: entry.reactionId,
            },
          });
          this.typingReactions.delete(jid);
          logger.info({ jid }, '飞书 setTyping(false): reaction 已移除');
        }
      }
    } catch (err) {
      logger.info({ err, jid, isTyping }, '飞书 typing indicator 操作失败');
    }
  }

  async syncGroups(): Promise<void> {
    try {
      let pageToken: string | undefined;
      do {
        const resp = await this.client.im.chat.list({
          params: {
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });
        const items = resp?.data?.items ?? [];
        for (const item of items) {
          if (item.chat_id && item.name) {
            const jid = `${JID_PREFIX}${item.chat_id}`;
            this.opts.onChatMetadata(
              jid,
              new Date().toISOString(),
              item.name,
              'feishu',
              true,
            );
          }
        }
        pageToken = resp?.data?.page_token;
      } while (pageToken);
      logger.info('飞书群列表同步完成');
    } catch (err) {
      logger.error({ err }, '飞书群列表同步失败');
    }
  }

  // ---- 内部方法 ----

  // 最近消息 ID 缓存（按 chat jid），用于 typing indicator
  private lastMessageIds = new Map<string, string>();

  private getLastMessageId(jid: string): string | undefined {
    return this.lastMessageIds.get(jid);
  }

  private handleMessage(data: {
    sender: {
      sender_id?: { union_id?: string; user_id?: string; open_id?: string };
      sender_type: string;
    };
    message: {
      message_id: string;
      root_id?: string;
      parent_id?: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>;
    };
  }): void {
    logger.info(
      {
        chatId: data.message.chat_id,
        msgType: data.message.message_type,
        senderType: data.sender.sender_type,
      },
      '飞书收到消息事件',
    );
    // 忽略机器人自己发的消息
    if (data.sender.sender_type === 'app') return;

    const { message, sender } = data;
    const jid = `${JID_PREFIX}${message.chat_id}`;
    const senderId =
      sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? 'unknown';

    // 记录最近消息 ID（用于 typing indicator）
    this.lastMessageIds.set(jid, message.message_id);

    // 解析消息内容
    let text = '';
    try {
      const parsed = JSON.parse(message.content);
      if (message.message_type === 'text') {
        text = parsed.text ?? '';
      } else if (message.message_type === 'post') {
        // 富文本：提取纯文本内容
        text = this.extractPostText(parsed);
      } else {
        // 其他消息类型暂不处理
        return;
      }
    } catch {
      logger.warn({ content: message.content }, '飞书消息内容解析失败');
      return;
    }

    if (!text.trim()) return;

    // 替换 @mention 标记为名称
    if (message.mentions) {
      for (const m of message.mentions) {
        text = text.replace(m.key, `@${m.name}`);
      }
    }

    // 通知元数据
    this.opts.onChatMetadata(
      jid,
      new Date().toISOString(),
      undefined,
      'feishu',
      message.chat_type === 'group',
    );

    const senderName =
      message.mentions?.find((m) => m.id.open_id === senderId)?.name ??
      senderId;

    const newMsg: NewMessage = {
      id: message.message_id,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content: text,
      timestamp: new Date().toISOString(),
      reply_to_message_id: message.parent_id,
      thread_id: message.root_id,
    };

    this.opts.onMessage(jid, newMsg);
  }

  /** 从飞书 post（富文本）内容中提取纯文本 */
  private extractPostText(parsed: Record<string, unknown>): string {
    const parts: string[] = [];
    const content = parsed.content as
      | Array<Array<{ tag: string; text?: string }>>
      | undefined;
    if (!content) return '';
    for (const line of content) {
      const lineTexts: string[] = [];
      for (const el of line) {
        if (el.text) lineTexts.push(el.text);
      }
      parts.push(lineTexts.join(''));
    }
    return parts.join('\n');
  }
}

// ---- 自注册 ----

registerChannel('feishu', (opts: ChannelOpts) => {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    logger.debug('飞书凭证未配置，跳过 feishu channel');
    return null;
  }

  return new FeishuChannel(appId, appSecret, opts);
});
