import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME } from '../config.js';
import type { ContainerOutput } from '../container-runner.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  startProgressServer,
  getProgressUrl,
  upsertSession,
  completeSession,
  deleteSession,
} from '../progress-server.js';
import { Channel, NewMessage } from '../types.js';

import { registerChannel, ChannelOpts } from './registry.js';

// ---- 配置 ----

const JID_PREFIX = 'fs:';
const TYPING_EMOJI = 'OnIt'; // 飞书内置 emoji key
const CARD_THRESHOLD = 500;
const MD_PATTERN = /```|\*\*|^##?\s|^\|.*\||\*[^*\s]|^[-*+]\s|^>\s/m;
const PROGRESS_EMOJI_PATTERN = /^[🔧📖✏️🔍🌐📋⚙️⏳💭✅📊]/;
const PROGRESS_JSON_PATTERN = /^\{"title":"[🔧📖✏️🔍🌐📋⚙️⏳💭✅📊]/;
const THINKING_PHRASES = ['思考中', '分析中', '处理中', '推理中'];

// ---- 多媒体安全限制 ----
const MAX_MERGE_TEXT_LEN = 8000;
const MAX_MERGE_IMAGES = 5;
const MAX_MERGE_DEPTH = 1;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

// 发送图片路径检测模式：[图片: path]、[image: path]、![alt](path)
const IMAGE_SEND_PATTERN =
  /(?:\[(?:图片|image):\s*(\/workspace\/group\/[^\]\s]+)\]|!\[.*?\]\((\/workspace\/group\/[^\s)]+)\))/gi;

// 发送文件路径检测模式：[文件: path]、[file: path]
const FILE_SEND_PATTERN =
  /\[(?:文件|file):\s*(\/workspace\/group\/[^\]\s]+)\]/gi;

/** 根据扩展名推断飞书文件类型 */
function feishuFileType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (['.mp4', '.mov', '.avi'].includes(ext)) return 'mp4';
  if (['.opus', '.ogg'].includes(ext)) return 'opus';
  return 'stream'; // 通用二进制，支持 txt/md/zip 等所有文件
}

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

/** 格式化耗时字符串 */
function formatElapsed(startTime: number): string {
  const ms = Date.now() - startTime;
  if (ms >= 60_000) {
    const min = Math.floor(ms / 60_000);
    const sec = Math.floor((ms % 60_000) / 1000);
    return `(${min}m${sec}s)`;
  }
  return `(${Math.floor(ms / 1000)}s)`;
}

/**
 * 标题行组件：左侧标题文字 + 右侧可选链接，同行布局。
 * 后跟一条 hr 分割线，与内容区隔开。
 * 复用于进度卡片和完成卡片。
 */
function buildTitleRow(leftText: string, rightUrl?: string): unknown[] {
  const rightContent = rightUrl
    ? `[📋 过程记录](${rightUrl})`
    : '\u200b'; // 无链接时用零宽字符占位，保持列结构合法

  return [
    {
      tag: 'column_set',
      flex_mode: 'stretch',
      background_style: 'default',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [{ tag: 'markdown', content: leftText }],
        },
        {
          tag: 'column',
          width: 'auto',
          elements: [{ tag: 'markdown', content: rightContent }],
        },
      ],
    },
    { tag: 'hr' },
  ];
}

/** 构建进度卡片（schema 2.0，无原生 header） */
function buildProgressCard(
  steps: ProgressStep[],
  frame: number = 0,
  startTime?: number,
  sessionId?: string,
): string {
  // 短语轮换（每轮 THINKING_PHRASES.length 帧切换一次）
  const phrase =
    THINKING_PHRASES[
      Math.floor(frame / THINKING_PHRASES.length) % THINKING_PHRASES.length
    ];
  const timeStr = startTime ? ` ${formatElapsed(startTime)}` : '';
  const titleText = `**✨ ${phrase}...${timeStr}**`;
  const progressUrl = sessionId ? getProgressUrl(sessionId) : undefined;

  // 没有步骤时显示占位文字，避免卡片内容区域为空
  const stepElements =
    steps.length > 0
      ? steps.map(stepToElement)
      : [{ tag: 'markdown', content: '<font color="grey">正在等待响应...</font>' }];

  const elements: unknown[] = [
    ...buildTitleRow(titleText, progressUrl),
    ...stepElements,
  ];

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    body: { elements },
  });
}

/** 各模型 context window 的兜底值（当 SDK 未返回时使用） */
const CLAUDE_CONTEXT_WINDOW_FALLBACK: Record<string, number> = {
  'claude-opus-4': 1_000_000,   // opus-4-5, opus-4-6, opus-4.x 全系
  'claude-sonnet-4': 200_000,
  'claude-haiku-4': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 200_000;

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

  // 获取实际 context window 大小：SDK 值与兜底表取最大值（SDK 有时返回偏小的值）
  let maxContextTokens = DEFAULT_CONTEXT_WINDOW;
  const modelNames = Object.keys(usage.modelContextWindows ?? {});

  // SDK 返回值
  if (usage.modelContextWindows) {
    const windows = Object.values(usage.modelContextWindows);
    if (windows.length > 0) {
      maxContextTokens = Math.max(...windows);
    }
  }

  // 兜底表：对每个模型名查表，取更大值（修正 SDK 返回偏小的情况）
  for (const [fallbackModel, fallbackWindow] of Object.entries(
    CLAUDE_CONTEXT_WINDOW_FALLBACK,
  )) {
    if (modelNames.some((k) => k.includes(fallbackModel))) {
      maxContextTokens = Math.max(maxContextTokens, fallbackWindow);
    }
  }

  // 计算 context window 占用率（最后一轮发送的完整 context）
  const totalContextTokens =
    usage.inputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens;
  const ctxPct = Math.round((totalContextTokens / maxContextTokens) * 100);
  const ctxBar = ctxPct >= 80 ? '🔴' : ctxPct >= 50 ? '🟡' : '🟢';
  const maxK = maxContextTokens >= 1_000_000
    ? `${maxContextTokens / 1_000_000}M`
    : `${maxContextTokens / 1_000}k`;

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: `<font color="grey">↑${inp}/${cacheRead}/${cacheCreate} ↓${out} 🔄${turns} ⏱${dur}s 💰≈$${cost} ${ctxBar}ctx${ctxPct}%/${maxK}</font>`,
  });
}

/** 构建完成卡片（schema 2.0，无原生 header） */
function buildCompletedCard(
  steps: ProgressStep[],
  usage?: ContainerOutput['usage'],
  startTime?: number,
  sessionId?: string,
): string {
  const timeStr = startTime ? ` ${formatElapsed(startTime)}` : '';
  const titleText = `**✓ 已完成${timeStr}**`;
  const progressUrl = sessionId ? getProgressUrl(sessionId) : undefined;

  const elements: unknown[] = [
    ...buildTitleRow(titleText, progressUrl),
    ...steps.map(stepToElement),
  ];
  if (usage) appendUsageFooter(elements, usage);

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
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
      sessionId: string;
      steps: ProgressStep[];
      frame: number;
      startTime: number;
      usage?: ContainerOutput['usage'];
    }
  >();

  // Spinner 自动刷新定时器（每个 chat 一个）
  private spinnerTimers = new Map<string, NodeJS.Timeout>();
  // 停止标记：clearSpinnerTimer 设置后，正在运行的 callback 检测到后不再调度下一轮
  private spinnerStopped = new Set<string>();

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
    // 启动进度查看 HTTP 服务（幂等，多次调用无副作用）
    startProgressServer();

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
        // 同步到进度查看页面（无上限，页面能看到完整历史）
        upsertSession(existing.sessionId, existing.steps, existing.startTime);
        // 不在此处立即 patch：由 spinner 定时器统一渲染，避免并发写同一条消息

        // 💭 消息额外作为普通消息发出（优先用 detail 完整内容，去掉 💭 前缀）
        if (title.startsWith('💭')) {
          const fullText = (detail ?? title).replace(/^💭\s*/, '').trim();
          if (fullText) {
            const chatId = chatIdFromJid(jid);
            this.sendPlainOrCard(chatId, fullText).catch((err) =>
              logger.debug({ err }, '💭 消息发送失败'),
            );
          }
        }
      }
      return;
    }

    // 正式回复到达：处理进度卡片
    const progressEntry = this.progressCards.get(jid);
    const usage = progressEntry?.usage;
    if (progressEntry) {
      this.clearSpinnerTimer(jid);
      this.progressCards.delete(jid);
      try {
        // 判断是否有真正的工具调用步骤（💭 开头的是模型推理文本，不算工具调用）
        const hasToolSteps = progressEntry.steps.some(
          (s) => !s.title.startsWith('💭'),
        );
        if (!hasToolSteps) {
          // 纯思考/简单对话（无工具调用）：撤回进度卡片，避免显示多余的"✅ 已完成"
          deleteSession(progressEntry.sessionId);
          await this.client.im.message.delete({
            path: { message_id: progressEntry.messageId },
          });
        } else {
          // 有工具调用步骤：转为完成卡片（不带 usage 脚注，usage 已在正文回复卡片里显示）
          completeSession(progressEntry.sessionId);
          await this.client.im.message.patch({
            path: { message_id: progressEntry.messageId },
            data: {
              content: buildCompletedCard(progressEntry.steps, undefined, progressEntry.startTime, progressEntry.sessionId),
            },
          });
        }
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

    // 检测文件路径
    const fileMatches: string[] = [];
    FILE_SEND_PATTERN.lastIndex = 0;
    while ((m = FILE_SEND_PATTERN.exec(text)) !== null) {
      fileMatches.push(m[1]);
    }

    const groupFolder = this.getGroupFolder(jid);

    if (imageMatches.length > 0 && groupFolder) {
      IMAGE_SEND_PATTERN.lastIndex = 0;
      FILE_SEND_PATTERN.lastIndex = 0;
      const remainingText = text
        .replace(IMAGE_SEND_PATTERN, '')
        .replace(FILE_SEND_PATTERN, '')
        .trim();
      try {
        if (remainingText)
          await this.sendPlainOrCard(chatId, remainingText, usage);
        for (const imgPath of imageMatches) {
          try {
            await this.sendImageMsg(chatId, imgPath, groupFolder);
          } catch (err) {
            logger.warn({ err, path: imgPath }, '飞书图片发送失败，降级为文本');
            await this.sendPlainOrCard(chatId, `[图片发送失败: ${imgPath}]`);
          }
        }
        for (const filePath of fileMatches) {
          try {
            await this.sendFileMsg(chatId, filePath, groupFolder);
          } catch (err) {
            logger.warn({ err, path: filePath }, '飞书文件发送失败，降级为文本');
            await this.sendPlainOrCard(chatId, `[文件发送失败: ${filePath}]`);
          }
        }
        return;
      } catch (err) {
        logger.error({ err }, '飞书发送消息失败');
        throw err;
      }
    }

    if (fileMatches.length > 0 && groupFolder) {
      FILE_SEND_PATTERN.lastIndex = 0;
      const remainingText = text.replace(FILE_SEND_PATTERN, '').trim();
      try {
        if (remainingText)
          await this.sendPlainOrCard(chatId, remainingText, usage);
        for (const filePath of fileMatches) {
          try {
            await this.sendFileMsg(chatId, filePath, groupFolder);
          } catch (err) {
            logger.warn({ err, path: filePath }, '飞书文件发送失败，降级为文本');
            await this.sendPlainOrCard(chatId, `[文件发送失败: ${filePath}]`);
          }
        }
        return;
      } catch (err) {
        logger.error({ err }, '飞书发送消息失败');
        throw err;
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
          content: JSON.stringify({
            schema: '2.0',
            config: { update_multi: true },
            body: { elements },
          }),
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
    this.spinnerStopped.add(jid); // 防止正在运行的 callback 再次调度
    const timer = this.spinnerTimers.get(jid);
    if (timer) {
      clearTimeout(timer);
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
          const SPINNER_INTERVAL_MS = 5000; // 5s
          const SPINNER_MAX_DURATION_MS = 10 * 60 * 1000; // 10 分钟硬上限

          const now = Date.now();
          this.spinnerStopped.delete(jid); // 新卡片启动，清除上次的停止标记
          const sessionId = crypto.randomBytes(8).toString('hex');
          const initialSteps: ProgressStep[] = [];
          upsertSession(sessionId, initialSteps, now);
          const resp = await this.client.im.message.create({
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: buildProgressCard(initialSteps, 0, now, sessionId),
            },
            params: { receive_id_type: 'chat_id' },
          });
          const msgId = resp?.data?.message_id;
          if (msgId) {
            this.progressCards.set(jid, {
              messageId: msgId,
              sessionId,
              steps: initialSteps,
              frame: 0,
              startTime: now,
            });

            // 启动 spinner 自动刷新定时器（递归 setTimeout：等上次 patch 完成再调度下次，避免并发）
            // 注意：clearSpinnerTimer 会设置 spinnerStopped，所以之后必须 delete 抵消，否则新 timer 立刻被拦截
            this.clearSpinnerTimer(jid);
            this.spinnerStopped.delete(jid);
            const spinnerStartTime = now;
            const scheduleSpinner = (): void => {
              const t = setTimeout(async () => {
                // 检查停止标记（clearSpinnerTimer 可能在此 callback 运行期间被调用）
                if (this.spinnerStopped.has(jid)) {
                  this.spinnerTimers.delete(jid);
                  return;
                }

                const entry = this.progressCards.get(jid);
                if (!entry) {
                  // 卡片已被删除（完成/清理），停止
                  this.spinnerTimers.delete(jid);
                  return;
                }

                // 硬上限保护
                if (Date.now() - spinnerStartTime > SPINNER_MAX_DURATION_MS) {
                  logger.warn(
                    { jid },
                    'Spinner timer 达到 10 分钟上限，自动停止',
                  );
                  this.spinnerTimers.delete(jid);
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
                        entry.sessionId,
                      ),
                    },
                  });
                } catch (err) {
                  logger.debug({ err, jid }, 'Spinner 自动刷新失败（非致命）');
                }

                // 本次完成后才调度下一次（再次检查停止标记）
                if (!this.spinnerStopped.has(jid)) {
                  scheduleSpinner();
                } else {
                  this.spinnerTimers.delete(jid);
                }
              }, SPINNER_INTERVAL_MS);
              this.spinnerTimers.set(jid, t);
            };
            scheduleSpinner();
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

  /** 上传并发送文件消息 */
  private async sendFileMsg(
    chatId: string,
    containerPath: string,
    groupFolder: string,
  ): Promise<void> {
    const relativePath = containerPath.replace(/^\/workspace\/group\//, '');
    const hostPath = path.join(resolveGroupFolderPath(groupFolder), relativePath);

    if (!fs.existsSync(hostPath)) {
      throw new Error(`文件不存在: ${hostPath}`);
    }

    const token = await this.getTenantAccessToken();
    if (!token) throw new Error('获取 tenant_access_token 失败');

    const filename = path.basename(hostPath);
    const fileType = feishuFileType(filename);

    // 上传文件
    const formData = new FormData();
    formData.append('file_type', fileType);
    formData.append('file_name', filename);
    formData.append('file', new Blob([fs.readFileSync(hostPath)]), filename);

    const uploadResp = await fetch('https://open.feishu.cn/open-apis/im/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const uploadData = (await uploadResp.json()) as { data?: { file_key?: string } };
    const fileKey = uploadData?.data?.file_key;
    if (!fileKey) throw new Error(`文件上传失败：${JSON.stringify(uploadData)}`);

    // 发送文件消息
    await this.client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
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
    if (data.sender.sender_type === 'app') {
      logger.info(
        { chatId: data.message.chat_id },
        '忽略机器人消息 (sender_type=app)',
      );
      return;
    }

    const { message, sender } = data;
    const jid = `${JID_PREFIX}${message.chat_id}`;
    const senderId =
      sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? 'unknown';

    // 记录最近消息 ID（用于 typing indicator）
    this.lastMessageIds.set(jid, message.message_id);

    // 获取 group folder（图片下载需要）
    const groupFolder = this.getGroupFolder(jid);

    logger.info(
      { jid, msgType: message.message_type, senderId },
      '飞书开始解析消息内容',
    );

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

    if (!text.trim()) {
      logger.info({ jid }, '飞书消息内容为空，跳过');
      return;
    }

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

    logger.info({ jid, text: text.slice(0, 80) }, '飞书消息分发到 onMessage');
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
