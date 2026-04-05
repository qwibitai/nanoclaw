import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, NewMessage } from '../types.js';

import { registerChannel, ChannelOpts } from './registry.js';

// ---- 配置 ----

const JID_PREFIX = 'fs:';
const TYPING_EMOJI = 'OnIt'; // 飞书内置 emoji key
const CARD_THRESHOLD = 500;
const MD_PATTERN = /```|^##\s|^\|.*\|/m;
const PROGRESS_EMOJI_PATTERN = /^[🔧📖✏️🔍🌐📋⚙️⏳💭✅📊]/;
const PROGRESS_JSON_PATTERN = /^\{"title":"[🔧📖✏️🔍🌐📋⚙️⏳💭✅📊]/;
const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
const THINKING_PHRASES = ['思考中', '分析中', '处理中', '推理中'];

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

interface ProgressStep {
  title: string;
  detail?: string;
}

/** 构建进度卡片（schema 2.0 + collapsible_panel） */
function buildProgressCard(steps: ProgressStep[], frame: number = 0): string {
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const phrase = THINKING_PHRASES[Math.floor(frame / SPINNER_FRAMES.length) % THINKING_PHRASES.length];

  const elements = steps.map((step) => {
    if (step.detail) {
      return {
        tag: 'collapsible_panel',
        expanded: false,
        background_color: 'grey',
        header: {
          title: { tag: 'markdown', content: step.title },
          vertical_align: 'center',
        },
        vertical_spacing: '2px',
        padding: '4px 8px 4px 8px',
        elements: [{ tag: 'markdown', content: step.detail }],
      };
    }
    return { tag: 'markdown', content: step.title };
  });

  return JSON.stringify({
    schema: '2.0',
    header: {
      template: 'yellow',
      title: { tag: 'plain_text', content: `${spinner} ${phrase}...` },
    },
    body: { elements },
  });
}

/** 构建完成卡片（schema 2.0 + collapsible_panel） */
function buildCompletedCard(steps: ProgressStep[]): string {
  const elements = steps.map((step) => {
    if (step.detail) {
      return {
        tag: 'collapsible_panel',
        expanded: false,
        background_color: 'grey',
        header: {
          title: { tag: 'markdown', content: step.title },
          vertical_align: 'center',
        },
        elements: [{ tag: 'markdown', content: step.detail }],
      };
    }
    return { tag: 'markdown', content: step.title };
  });

  return JSON.stringify({
    schema: '2.0',
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '✅ 已完成' },
    },
    body: { elements },
  });
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

  // 机器人自身的 open_id，用于识别 @机器人 mention
  private botOpenId: string | null = null;

  // 记录 jid → { messageId, reactionId }，用于移除 typing indicator
  private typingReactions = new Map<
    string,
    { messageId: string; reactionId: string }
  >();

  // 进度卡片状态：每个 chat 一张进度卡片，持续更新
  private progressCards = new Map<
    string,
    { messageId: string; steps: ProgressStep[]; frame: number }
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

    // 获取机器人自身 open_id，用于将 @机器人 替换为 @ASSISTANT_NAME 以匹配触发词
    try {
      const tokenResp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      });
      const tokenData = await tokenResp.json() as { tenant_access_token?: string };
      if (tokenData.tenant_access_token) {
        const botResp = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
          headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        });
        const botData = await botResp.json() as { bot?: { open_id?: string } };
        this.botOpenId = botData?.bot?.open_id ?? null;
      }
    } catch { /* 非致命 */ }

    logger.info({ botOpenId: this.botOpenId }, '飞书 WebSocket 已连接');
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

    // 进度消息 → 聚合到进度卡片（支持 JSON 格式含 detail，或纯文本 emoji 开头）
    const isProgressJson = PROGRESS_JSON_PATTERN.test(text);
    const isProgressEmoji = PROGRESS_EMOJI_PATTERN.test(text);
    if (isProgressJson || isProgressEmoji) {
      let title = text;
      let detail: string | undefined;
      if (isProgressJson) {
        try {
          const parsed = JSON.parse(text) as { title?: string; detail?: string };
          if (parsed.title) { title = parsed.title; detail = parsed.detail; }
        } catch { /* 降级为纯文本 */ }
      }

      const existing = this.progressCards.get(jid);
      if (existing) {
        existing.steps.push({ title, detail });
        if (existing.steps.length > 12) existing.steps.shift();
        existing.frame++;
        try {
          await this.client.im.message.patch({
            path: { message_id: existing.messageId },
            data: { content: buildProgressCard(existing.steps, existing.frame) },
          });
        } catch (err) {
          logger.debug({ err }, '飞书进度卡片更新失败（非致命）');
        }
      }
      return;
    }

    // 正式回复到达：将进度卡片标记为「✅ 已完成」
    const progressEntry = this.progressCards.get(jid);
    if (progressEntry) {
      this.progressCards.delete(jid);
      try {
        await this.client.im.message.patch({
          path: { message_id: progressEntry.messageId },
          data: { content: buildCompletedCard(progressEntry.steps) },
        });
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
    const chatId = chatIdFromJid(jid);
    try {
      if (isTyping) {
        // 添加 emoji reaction 到用户消息
        const lastMsgId = this.getLastMessageId(jid);
        if (lastMsgId) {
          const resp = await this.client.im.messageReaction.create({
            data: { reaction_type: { emoji_type: TYPING_EMOJI } },
            path: { message_id: lastMsgId },
          });
          const reactionId = resp?.data?.reaction_id;
          if (reactionId) {
            this.typingReactions.set(jid, { messageId: lastMsgId, reactionId });
          }
        }

        // 发送"处理中"进度卡片
        if (!this.progressCards.has(jid)) {
          const initialSteps: ProgressStep[] = [{ title: '⏳ 正在思考...' }];
          const resp = await this.client.im.message.create({
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: buildProgressCard(initialSteps, 0),
            },
            params: { receive_id_type: 'chat_id' },
          });
          const msgId = resp?.data?.message_id;
          if (msgId) {
            this.progressCards.set(jid, { messageId: msgId, steps: initialSteps, frame: 0 });
          }
        }
      } else {
        // 移除 emoji reaction
        const entry = this.typingReactions.get(jid);
        if (entry) {
          await this.client.im.messageReaction.delete({
            path: { message_id: entry.messageId, reaction_id: entry.reactionId },
          });
          this.typingReactions.delete(jid);
        }
      }
    } catch (err) {
      logger.debug({ err, jid, isTyping }, '飞书 typing indicator 操作失败');
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

    // 替换 @mention 标记为名称；@机器人 → @ASSISTANT_NAME（匹配触发词）
    if (message.mentions) {
      for (const m of message.mentions) {
        const isBotMention = this.botOpenId && m.id.open_id === this.botOpenId;
        text = text.replace(m.key, isBotMention ? `@${ASSISTANT_NAME}` : `@${m.name}`);
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
