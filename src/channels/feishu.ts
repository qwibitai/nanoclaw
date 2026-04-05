import fs from 'fs';
import path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME } from '../config.js';
import type { ContainerOutput } from '../container-runner.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
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

// ---- 多媒体安全限制 ----
const MAX_MERGE_TEXT_LEN = 8000;
const MAX_MERGE_IMAGES = 5;
const MAX_MERGE_DEPTH = 1;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

// 发送图片路径检测模式：[图片: path]、[image: path]、![alt](path)
const IMAGE_SEND_PATTERN =
  /(?:\[(?:图片|image):\s*(\/workspace\/group\/[^\]\s]+)\]|!\[.*?\]\((\/workspace\/group\/[^\s)]+)\))/gi;

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

/** 截断 step 标题：取第一行，最多 80 字符 */
function truncateTitle(title: string): string {
  const firstLine = title.split('\n')[0];
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
}

/** 对 diff 内容着色：+ 行绿色，- 行红色 */
function colorizeDiff(text: string): string {
  return text
    .replace(/^(\+\s?.*)$/gm, '<font color="green">$1</font>')
    .replace(/^(-\s?.*)$/gm, '<font color="red">$1</font>');
}

/** 将 step 转为卡片 element */
function stepToElement(step: ProgressStep): unknown {
  const title = truncateTitle(step.title);
  if (step.detail) {
    return {
      tag: 'collapsible_panel',
      expanded: false,
      background_color: 'grey',
      header: {
        title: { tag: 'plain_text', content: title },
        vertical_align: 'center',
      },
      vertical_spacing: '2px',
      padding: '4px 8px 4px 8px',
      elements: [{ tag: 'markdown', content: colorizeDiff(step.detail) }],
    };
  }
  return { tag: 'markdown', content: title };
}

/** 构建进度卡片（schema 2.0 + collapsible_panel） */
function buildProgressCard(
  steps: ProgressStep[],
  frame: number = 0,
  startTime?: number,
): string {
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const phrase =
    THINKING_PHRASES[
      Math.floor(frame / SPINNER_FRAMES.length) % THINKING_PHRASES.length
    ];

  // 计时器显示
  let timeStr = '';
  if (startTime) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed >= 60) {
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      timeStr = ` (${min}m${sec}s)`;
    } else {
      timeStr = ` (${elapsed}s)`;
    }
  }

  const elements = steps.map(stepToElement);

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'yellow',
      title: {
        tag: 'plain_text',
        content: `${spinner} ${phrase}...${timeStr}`,
      },
    },
    body: { elements },
  });
}

/** 向卡片 elements 追加 usage 脚注（hr + 灰色统计行） */
function appendUsageFooter(
  elements: unknown[],
  usage: NonNullable<ContainerOutput['usage']>,
): void {
  const inp = usage.inputTokens.toLocaleString();
  const cacheRead = usage.cacheReadInputTokens.toLocaleString();
  const cacheCreate = usage.cacheCreationInputTokens.toLocaleString();
  const out = usage.outputTokens.toLocaleString();
  const turns = usage.numTurns;
  const dur = (usage.durationMs / 1000).toFixed(1);
  const cost = usage.totalCostUsd.toFixed(2);

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: `<font color="grey">↑${inp}/${cacheRead}/${cacheCreate} ↓${out} 🔄${turns} ⏱${dur}s 💰≈$${cost}</font>`,
  });
}

/** 构建完成卡片（schema 2.0 + collapsible_panel） */
function buildCompletedCard(
  steps: ProgressStep[],
  usage?: ContainerOutput['usage'],
): string {
  const elements: unknown[] = steps.map(stepToElement);

  if (usage) appendUsageFooter(elements, usage);

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
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
    {
      messageId: string;
      steps: ProgressStep[];
      frame: number;
      startTime: number;
      usage?: ContainerOutput['usage'];
    }
  >();

  // Spinner 自动刷新定时器（每个 chat 一个）
  private spinnerTimers = new Map<string, NodeJS.Timeout>();

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
        this.handleMessage(data).catch((err) => {
          logger.error({ err }, '飞书消息处理失败');
        });
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
      const tokenResp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_id: this.appId,
            app_secret: this.appSecret,
          }),
        },
      );
      const tokenData = (await tokenResp.json()) as {
        tenant_access_token?: string;
      };
      if (tokenData.tenant_access_token) {
        const botResp = await fetch(
          'https://open.feishu.cn/open-apis/bot/v3/info',
          {
            headers: {
              Authorization: `Bearer ${tokenData.tenant_access_token}`,
            },
          },
        );
        const botData = (await botResp.json()) as {
          bot?: { open_id?: string };
        };
        this.botOpenId = botData?.bot?.open_id ?? null;
      }
    } catch {
      /* 非致命 */
    }

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
          const parsed = JSON.parse(text) as {
            title?: string;
            detail?: string;
          };
          if (parsed.title) {
            title = parsed.title;
            detail = parsed.detail;
          }
        } catch {
          /* 降级为纯文本 */
        }
      }

      const existing = this.progressCards.get(jid);
      if (existing) {
        existing.steps.push({ title, detail });
        if (existing.steps.length > 12) existing.steps.shift();
        existing.frame++;
        try {
          await this.client.im.message.patch({
            path: { message_id: existing.messageId },
            data: {
              content: buildProgressCard(
                existing.steps,
                existing.frame,
                existing.startTime,
              ),
            },
          });
        } catch (err) {
          logger.debug({ err }, '飞书进度卡片更新失败（非致命）');
        }
      }
      return;
    }

    // 正式回复到达：将进度卡片标记为「✅ 已完成」，取出 usage
    const progressEntry = this.progressCards.get(jid);
    const usage = progressEntry?.usage;
    if (progressEntry) {
      this.clearSpinnerTimer(jid);
      this.progressCards.delete(jid);
      try {
        await this.client.im.message.patch({
          path: { message_id: progressEntry.messageId },
          data: {
            content: buildCompletedCard(
              progressEntry.steps,
              progressEntry.usage,
            ),
          },
        });
      } catch (err) {
        logger.debug({ err }, '飞书进度卡片更新失败（非致命）');
      }
    }

    // 检测文本中的图片路径，提取并发送
    const imageMatches: string[] = [];
    let m: RegExpExecArray | null;
    IMAGE_SEND_PATTERN.lastIndex = 0;
    while ((m = IMAGE_SEND_PATTERN.exec(text)) !== null) {
      imageMatches.push(m[1] || m[2]);
    }

    if (imageMatches.length > 0) {
      const groupFolder = this.getGroupFolder(jid);
      if (groupFolder) {
        IMAGE_SEND_PATTERN.lastIndex = 0;
        const remainingText = text.replace(IMAGE_SEND_PATTERN, '').trim();
        try {
          if (remainingText)
            await this.sendPlainOrCard(chatId, remainingText, usage);
          for (const imgPath of imageMatches) {
            try {
              await this.sendImageMsg(chatId, imgPath, groupFolder);
            } catch (err) {
              logger.warn(
                { err, path: imgPath },
                '飞书图片发送失败，降级为文本',
              );
              await this.sendPlainOrCard(chatId, `[图片发送失败: ${imgPath}]`);
            }
          }
          return;
        } catch (err) {
          logger.error({ err }, '飞书发送消息失败');
          throw err;
        }
      }
    }

    try {
      await this.sendPlainOrCard(chatId, text, usage);
    } catch (err) {
      logger.error({ err }, '飞书发送消息失败');
      throw err;
    }
  }

  /** 发送纯文本或卡片消息（内部方法）。有 usage 时强制走卡片并追加脚注 */
  private async sendPlainOrCard(
    chatId: string,
    text: string,
    usage?: ContainerOutput['usage'],
  ): Promise<void> {
    if (usage || shouldUseCard(text)) {
      const elements: unknown[] = [{ tag: 'markdown', content: text }];
      if (usage) appendUsageFooter(elements, usage);
      await this.client.im.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({ elements }),
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

  /** 设置指定 chat 的最新 usage 数据（下次完成卡片渲染时使用） */
  setUsage(jid: string, usage: ContainerOutput['usage']): void {
    const entry = this.progressCards.get(jid);
    if (entry) {
      entry.usage = usage;
    }
  }

  private clearSpinnerTimer(jid: string): void {
    const timer = this.spinnerTimers.get(jid);
    if (timer) {
      clearInterval(timer);
      this.spinnerTimers.delete(jid);
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
          const SPINNER_INTERVAL_MS = 3000;
          const SPINNER_MAX_DURATION_MS = 10 * 60 * 1000; // 10 分钟硬上限

          const now = Date.now();
          const initialSteps: ProgressStep[] = [{ title: '⏳ 正在思考...' }];
          const resp = await this.client.im.message.create({
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: buildProgressCard(initialSteps, 0, now),
            },
            params: { receive_id_type: 'chat_id' },
          });
          const msgId = resp?.data?.message_id;
          if (msgId) {
            this.progressCards.set(jid, {
              messageId: msgId,
              steps: initialSteps,
              frame: 0,
              startTime: now,
            });

            // 启动 spinner 自动刷新定时器
            this.clearSpinnerTimer(jid);
            const spinnerStartTime = now;
            const timer = setInterval(async () => {
              const entry = this.progressCards.get(jid);
              if (!entry) {
                // 卡片已被删除（完成/清理），停止定时器
                this.clearSpinnerTimer(jid);
                return;
              }

              // 硬上限保护
              if (Date.now() - spinnerStartTime > SPINNER_MAX_DURATION_MS) {
                logger.warn(
                  { jid },
                  'Spinner timer 达到 10 分钟上限，自动停止',
                );
                this.clearSpinnerTimer(jid);
                return;
              }

              entry.frame++;
              try {
                await this.client.im.message.patch({
                  path: { message_id: entry.messageId },
                  data: {
                    content: buildProgressCard(
                      entry.steps,
                      entry.frame,
                      entry.startTime,
                    ),
                  },
                });
              } catch (err) {
                logger.debug({ err, jid }, 'Spinner 自动刷新失败（非致命）');
              }
            }, SPINNER_INTERVAL_MS);
            this.spinnerTimers.set(jid, timer);
          }
        }
      } else {
        // 清理 spinner 定时器
        this.clearSpinnerTimer(jid);
        // 移除 emoji reaction
        const entry = this.typingReactions.get(jid);
        if (entry) {
          await this.client.im.messageReaction.delete({
            path: {
              message_id: entry.messageId,
              reaction_id: entry.reactionId,
            },
          });
          this.typingReactions.delete(jid);
        }
      }
    } catch (err) {
      logger.debug({ err, jid, isTyping }, '飞书 typing indicator 操作失败');
    }
  }

  async sendAuthCard(jid: string, authUrl: string): Promise<void> {
    const chatId = chatIdFromJid(jid);
    const card = JSON.stringify({
      elements: [
        {
          tag: 'markdown',
          content:
            '🔑 **需要飞书文档授权**\n\n要读取或创建飞书文档，需要你授权一次。\n授权后自动生效，无需重复操作。',
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '👉 点击授权' },
              type: 'primary',
              multi_url: { url: authUrl },
            },
          ],
        },
      ],
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '飞书文档授权' },
      },
    });
    try {
      await this.client.im.message.create({
        data: { receive_id: chatId, msg_type: 'interactive', content: card },
        params: { receive_id_type: 'chat_id' },
      });
      logger.info({ jid }, '飞书授权卡片发送成功');
    } catch (err) {
      // schema 1.0 卡片失败时降级为纯文本链接
      logger.warn({ err }, '飞书授权卡片发送失败，降级为文本链接');
      try {
        await this.client.im.message.create({
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({
              text: `🔑 需要飞书文档授权\n\n请点击链接完成授权：${authUrl}\n\n授权后自动生效。`,
            }),
          },
          params: { receive_id_type: 'chat_id' },
        });
      } catch (fallbackErr) {
        logger.error({ fallbackErr }, '飞书授权文本链接也发送失败');
      }
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

  private getGroupFolder(jid: string): string | null {
    const groups = this.opts.registeredGroups();
    return groups[jid]?.folder ?? null;
  }

  /** 获取 tenant_access_token（用于 REST API 调用） */
  private async getTenantAccessToken(): Promise<string | null> {
    try {
      const resp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_id: this.appId,
            app_secret: this.appSecret,
          }),
        },
      );
      const data = (await resp.json()) as { tenant_access_token?: string };
      return data.tenant_access_token ?? null;
    } catch (err) {
      logger.error({ err }, '获取 tenant_access_token 失败');
      return null;
    }
  }

  /** 下载飞书图片到 group 目录，返回容器内路径 */
  private async downloadImage(
    messageId: string,
    imageKey: string,
    groupFolder: string,
  ): Promise<string | null> {
    try {
      const token = await this.getTenantAccessToken();
      if (!token) return null;

      const groupDir = resolveGroupFolderPath(groupFolder);
      const imagesDir = path.join(groupDir, 'images');
      fs.mkdirSync(imagesDir, { recursive: true });

      const filename = `${messageId}_${imageKey}.jpg`;
      const filePath = path.join(imagesDir, filename);

      const resp = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!resp.ok) {
        logger.warn(
          { messageId, imageKey, status: resp.status },
          '飞书图片下载 HTTP 错误',
        );
        return null;
      }

      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_IMAGE_SIZE) {
        logger.warn(
          { messageId, imageKey, size: buf.length },
          '图片超过 20MB 限制',
        );
        return null;
      }

      fs.writeFileSync(filePath, buf);
      const containerPath = `/workspace/group/images/${filename}`;
      logger.info({ messageId, imageKey, containerPath }, '飞书图片下载成功');
      return containerPath;
    } catch (err) {
      logger.error({ err, messageId, imageKey }, '飞书图片下载失败');
      return null;
    }
  }

  /** 从飞书 post（富文本）中提取文本和图片 key */
  extractPostContent(parsed: Record<string, unknown>): {
    text: string;
    imageKeys: string[];
  } {
    const parts: string[] = [];
    const imageKeys: string[] = [];

    const title = ((parsed.title as string) || '').trim();
    if (title) parts.push(title);

    const content = parsed.content as
      | Array<Array<{ tag: string; text?: string; image_key?: string }>>
      | undefined;
    if (!content) return { text: parts.join('\n'), imageKeys };

    for (const line of content) {
      const lineTexts: string[] = [];
      for (const el of line) {
        if ((el.tag === 'text' || el.tag === 'a') && el.text) {
          lineTexts.push(el.text);
        } else if (el.tag === 'img' && el.image_key) {
          imageKeys.push(el.image_key);
        }
      }
      if (lineTexts.length > 0) parts.push(lineTexts.join(''));
    }

    return { text: parts.join('\n'), imageKeys };
  }

  /** 解析合并转发消息（参考 Nine adapter.py _parse_merge_forward） */
  private async parseMergeForward(
    messageId: string,
    groupFolder: string | null,
    depth: number = 0,
  ): Promise<{ text: string; imagePaths: string[] }> {
    if (depth > MAX_MERGE_DEPTH) {
      return { text: '[嵌套转发内容已省略]', imagePaths: [] };
    }

    const token = await this.getTenantAccessToken();
    if (!token) {
      return { text: '[合并转发消息，认证失败无法解析]', imagePaths: [] };
    }

    let items: Array<{
      message_id?: string;
      msg_type?: string;
      sender?: { id: string; sender_type: string };
      body?: { content: string };
    }>;
    try {
      const resp = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await resp.json()) as {
        code?: number;
        data?: { items?: typeof items };
      };
      if (data.code !== 0) {
        logger.error(
          { messageId, code: data.code },
          '飞书合并转发 API 返回错误',
        );
        return { text: '[合并转发消息，API 返回错误]', imagePaths: [] };
      }
      items = data.data?.items ?? [];
    } catch (err) {
      logger.error({ err, messageId }, '飞书合并转发 API 调用失败');
      return { text: '[合并转发消息，API 调用失败]', imagePaths: [] };
    }

    if (items.length === 0) {
      return { text: '[合并转发消息，无子消息]', imagePaths: [] };
    }

    const texts: string[] = [];
    const imagePaths: string[] = [];
    let totalTextLen = 0;
    let skippedCount = 0;

    for (const item of items) {
      const itemMsgType = item.msg_type ?? '';

      // 合并转发类型：递归解析（跳过自身）
      if (itemMsgType === 'merge_forward') {
        if (depth < MAX_MERGE_DEPTH) {
          const nestedId = item.message_id ?? '';
          if (nestedId && nestedId !== messageId) {
            const nested = await this.parseMergeForward(
              nestedId,
              groupFolder,
              depth + 1,
            );
            if (nested.text) {
              texts.push(nested.text);
              totalTextLen += nested.text.length;
            }
            imagePaths.push(...nested.imagePaths);
          }
        } else {
          texts.push('[嵌套转发内容已省略]');
        }
        continue;
      }

      const subContent = item.body?.content ?? '{}';
      const senderLabel = item.sender?.sender_type || item.sender?.id || '未知';

      // 按类型解析子消息
      let subText = '';
      const subImageKeys: string[] = [];
      try {
        const parsed = JSON.parse(subContent);
        if (itemMsgType === 'text') {
          subText = parsed.text ?? '';
        } else if (itemMsgType === 'image') {
          if (parsed.image_key) subImageKeys.push(parsed.image_key);
        } else if (itemMsgType === 'post') {
          const postResult = this.extractPostContent(parsed);
          subText = postResult.text;
          subImageKeys.push(...postResult.imageKeys);
        }
      } catch {
        subText = subContent;
      }

      // 文本长度限制
      if (subText) {
        if (totalTextLen + subText.length > MAX_MERGE_TEXT_LEN) {
          skippedCount++;
          continue;
        }
        texts.push(`[${senderLabel}]: ${subText}`);
        totalTextLen += subText.length;
      }

      // 下载图片（受数量限制）
      if (subImageKeys.length > 0 && groupFolder) {
        const remaining = MAX_MERGE_IMAGES - imagePaths.length;
        for (const key of subImageKeys.slice(0, Math.max(0, remaining))) {
          const imgPath = await this.downloadImage(
            item.message_id ?? messageId,
            key,
            groupFolder,
          );
          if (imgPath) imagePaths.push(imgPath);
        }
      }
    }

    if (skippedCount > 0) {
      texts.push(`[...还有 ${skippedCount} 条消息已省略]`);
    }

    return {
      text: texts.length > 0 ? `[转发消息]\n${texts.join('\n')}` : '[转发消息]',
      imagePaths,
    };
  }

  /** 上传并发送图片消息 */
  private async sendImageMsg(
    chatId: string,
    containerPath: string,
    groupFolder: string,
  ): Promise<void> {
    const relativePath = containerPath.replace(/^\/workspace\/group\//, '');
    const hostPath = path.join(
      resolveGroupFolderPath(groupFolder),
      relativePath,
    );

    if (!fs.existsSync(hostPath)) {
      throw new Error(`图片文件不存在: ${hostPath}`);
    }

    const token = await this.getTenantAccessToken();
    if (!token) throw new Error('获取 tenant_access_token 失败');

    // 上传图片
    const formData = new FormData();
    formData.append('image_type', 'message');
    formData.append(
      'image',
      new Blob([fs.readFileSync(hostPath)]),
      path.basename(hostPath),
    );

    const uploadResp = await fetch(
      'https://open.feishu.cn/open-apis/im/v1/images',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );
    const uploadData = (await uploadResp.json()) as {
      data?: { image_key?: string };
    };
    const imageKey = uploadData?.data?.image_key;
    if (!imageKey) throw new Error('图片上传失败：未返回 image_key');

    // 发送图片消息
    await this.client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
      params: { receive_id_type: 'chat_id' },
    });
  }

  private async handleMessage(data: {
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
  }): Promise<void> {
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

    // 获取 group folder（图片下载需要）
    const groupFolder = this.getGroupFolder(jid);

    // 解析消息内容
    let text = '';
    try {
      if (message.message_type === 'image') {
        // 图片消息：下载图片并标记路径
        const parsed = JSON.parse(message.content);
        const imageKey = parsed.image_key;
        if (imageKey && groupFolder) {
          const imgPath = await this.downloadImage(
            message.message_id,
            imageKey,
            groupFolder,
          );
          text = imgPath ? `[图片: ${imgPath}]` : '[图片: 下载失败]';
        } else if (imageKey) {
          text = '[图片: 群未注册，无法下载]';
        } else {
          return;
        }
      } else if (message.message_type === 'merge_forward') {
        // 合并转发：递归解析子消息
        const result = await this.parseMergeForward(
          message.message_id,
          groupFolder,
        );
        text = result.text;
        for (const imgPath of result.imagePaths) {
          text += `\n[图片: ${imgPath}]`;
        }
      } else {
        const parsed = JSON.parse(message.content);
        if (message.message_type === 'text') {
          text = parsed.text ?? '';
        } else if (message.message_type === 'post') {
          // 富文本：提取文本 + 图片
          const postResult = this.extractPostContent(parsed);
          text = postResult.text;
          if (postResult.imageKeys.length > 0 && groupFolder) {
            for (const imageKey of postResult.imageKeys) {
              const imgPath = await this.downloadImage(
                message.message_id,
                imageKey,
                groupFolder,
              );
              if (imgPath) text += `\n[图片: ${imgPath}]`;
            }
          }
        } else {
          // 其他消息类型暂不处理
          return;
        }
      }
    } catch (err) {
      logger.warn({ content: message.content, err }, '飞书消息内容解析失败');
      return;
    }

    if (!text.trim()) return;

    // 替换 @mention 标记为名称；@机器人 → @ASSISTANT_NAME（匹配触发词）
    if (message.mentions) {
      for (const m of message.mentions) {
        const isBotMention = this.botOpenId && m.id.open_id === this.botOpenId;
        text = text.replace(
          m.key,
          isBotMention ? `@${ASSISTANT_NAME}` : `@${m.name}`,
        );
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
