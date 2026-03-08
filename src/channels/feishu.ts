import * as fs from 'node:fs';
import * as path from 'node:path';

import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
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
const FEISHU_BACKOFF_CODES = new Set([99991400, 99991403, 429]);
const WITHDRAWN_REPLY_CODES = new Set([230011, 231003]);

// --- Core utilities ---

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

function buildPostPayload(text: string): string {
  return JSON.stringify({
    zh_cn: { content: [[{ tag: 'md', text }]] },
  });
}

// Detect Feishu API rate-limit / quota-exceeded errors from thrown errors.
// The SDK may surface these as { code } or as Axios { response.data.code }.
function isBackoffError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: number }).code;
  if (typeof code === 'number' && FEISHU_BACKOFF_CODES.has(code)) return true;
  const resData = (err as { response?: { data?: { code?: number } } }).response
    ?.data;
  if (
    typeof resData?.code === 'number' &&
    FEISHU_BACKOFF_CODES.has(resData.code)
  )
    return true;
  return false;
}

// --- parsePostContent: parse Feishu rich-text (post) to Markdown ---
// Ported from openclaw extensions/feishu/src/post.ts

const MARKDOWN_SPECIAL_CHARS = /([\\`*_{}[\]()#+\-!|>~])/g;

function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_SPECIAL_CHARS, '\\$1');
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function renderPostElement(el: unknown, imageKeys: string[]): string {
  if (!isRec(el)) return escapeMarkdown(toStr(el));
  const tag = toStr(el.tag).toLowerCase();
  switch (tag) {
    case 'text': {
      const style = isRec(el.style) ? el.style : undefined;
      const isCode =
        style?.code === true || style?.code === 1 || style?.code === 'true';
      const raw = toStr(el.text);
      if (isCode) return raw ? `\`${raw}\`` : '';
      let t = escapeMarkdown(raw);
      if (!t) return '';
      if (style?.bold) t = `**${t}**`;
      if (style?.italic) t = `*${t}*`;
      if (style?.strikethrough || style?.line_through) t = `~~${t}~~`;
      return t;
    }
    case 'a': {
      const href = toStr(el.href).trim();
      const txt = toStr(el.text) || href;
      return href ? `[${escapeMarkdown(txt)}](${href})` : escapeMarkdown(txt);
    }
    case 'at': {
      const name =
        toStr(el.user_name) || toStr(el.user_id) || toStr(el.open_id);
      return name ? `@${escapeMarkdown(name)}` : '';
    }
    case 'img': {
      const key = toStr(el.image_key);
      if (key) imageKeys.push(key);
      return '![image]';
    }
    case 'br':
      return '\n';
    case 'hr':
      return '\n\n---\n\n';
    case 'code_block':
    case 'pre': {
      const lang = toStr(el.language || el.lang)
        .trim()
        .replace(/[^A-Za-z0-9_+#.-]/g, '');
      const code = (toStr(el.text) || toStr(el.content)).replace(/\r\n/g, '\n');
      return `\`\`\`${lang}\n${code}${code.endsWith('\n') ? '' : '\n'}\`\`\``;
    }
    default:
      return escapeMarkdown(toStr(el.text));
  }
}

export function parsePostContent(content: string): {
  textContent: string;
  imageKeys: string[];
} {
  try {
    const parsed = JSON.parse(content);
    if (!isRec(parsed))
      return { textContent: '[Rich text message]', imageKeys: [] };

    // Resolve locale payload: { zh_cn: { title, content } } or direct { title, content }
    let payload: { title?: unknown; content: unknown[] } | null = null;
    if (Array.isArray(parsed.content)) {
      payload = parsed as { title?: unknown; content: unknown[] };
    } else {
      for (const v of Object.values(parsed)) {
        if (isRec(v) && Array.isArray(v.content)) {
          payload = v as { title?: unknown; content: unknown[] };
          break;
        }
      }
    }
    if (!payload) return { textContent: '[Rich text message]', imageKeys: [] };

    const imageKeys: string[] = [];
    const paragraphs: string[] = [];
    for (const para of payload.content) {
      if (!Array.isArray(para)) continue;
      paragraphs.push(
        para.map((el) => renderPostElement(el, imageKeys)).join(''),
      );
    }
    const title = escapeMarkdown(toStr(payload.title).trim());
    const body = paragraphs.join('\n').trim();
    const textContent =
      [title, body].filter(Boolean).join('\n\n').trim() ||
      '[Rich text message]';
    return { textContent, imageKeys };
  } catch {
    return { textContent: '[Rich text message]', imageKeys: [] };
  }
}

function parseQuotedContent(rawContent: string, msgType: string): string {
  if (!rawContent) return '';
  try {
    const parsed = JSON.parse(rawContent);
    if (msgType === 'text') return toStr(parsed.text);
    if (msgType === 'post') return parsePostContent(rawContent).textContent;
    if (msgType === 'image') return '[Image]';
    if (msgType === 'file')
      return `[File: ${toStr(parsed.file_name) || 'unknown'}]`;
    if (msgType === 'audio') return '[Audio]';
    if (msgType === 'interactive') return '[Interactive Card]';
    return `[${msgType}]`;
  } catch {
    return rawContent;
  }
}

async function fetchQuotedMessage(
  client: Lark.Client,
  parentId: string,
): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (client.im.message as any).get({
      path: { message_id: parentId },
    });
    if (res?.code !== 0) return null;
    const item = res?.data?.items?.[0] ?? res?.data;
    if (!item) return null;
    const msgType = toStr(item.msg_type ?? item.message_type) || 'text';
    const rawContent = toStr(item.body?.content);
    return parseQuotedContent(rawContent, msgType) || null;
  } catch {
    return null;
  }
}

async function downloadMedia(
  client: Lark.Client,
  messageId: string,
  resourceType: 'image' | 'file',
  fileKey: string,
  groupFolder: string,
): Promise<string | null> {
  if (!fileKey) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (client.im.messageResource as any).get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: resourceType },
    });

    let buffer: Buffer | null = null;
    if (Buffer.isBuffer(response)) {
      buffer = response;
    } else if (response instanceof ArrayBuffer) {
      buffer = Buffer.from(response);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } else if (isRec(response) && Buffer.isBuffer((response as any).data)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buffer = (response as any).data as Buffer;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } else if (
      isRec(response) &&
      typeof (response as any).getReadableStream === 'function'
    ) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = (response as any).getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      buffer = Buffer.concat(chunks);
    }

    if (!buffer) return null;

    const ext = resourceType === 'image' ? 'jpg' : 'bin';
    const mediaDir = path.join(groupFolder, 'media');
    await fs.promises.mkdir(mediaDir, { recursive: true });
    const filename = `${Date.now()}_${fileKey.slice(-8)}.${ext}`;
    const filePath = path.join(mediaDir, filename);
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
  } catch (err) {
    logger.debug({ err, resourceType }, 'Feishu: media download failed');
    return null;
  }
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;
  private botOpenId: string | null = null;
  private opts: FeishuChannelOpts;
  private lastMessageIdByJid: Record<string, string> = {};
  private lastReactionIdByJid: Record<
    string,
    { messageId: string; reactionId: string }
  > = {};
  private typingBackoffUntil = 0;
  private readonly TYPING_BACKOFF_MS = 5 * 60 * 1000;
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
      const res = await this.client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      this.botOpenId = (res as any)?.bot?.open_id ?? null;
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
    const msgType: string = message.message_type ?? 'text';

    // Feishu create_time is a Unix timestamp in milliseconds as a string
    const createTimeMs = parseInt(message.create_time ?? '0', 10);
    const timestamp = new Date(createTimeMs).toISOString();

    // Build JID: p2p uses open_id, group uses chat_id
    const jid = chatType === 'p2p' ? `fs:p_${openId}` : `fs:${chatId}`;

    const isGroup = chatType === 'group';
    const chatName = isGroup ? chatId : openId;

    this.opts.onChatMetadata(jid, timestamp, chatName, 'feishu', isGroup);

    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      logger.debug({ jid, chatName }, 'Feishu message from unregistered chat');
      return;
    }

    // Parse content based on message type
    let content = '';
    if (msgType === 'post') {
      const { textContent, imageKeys } = parsePostContent(
        message.content ?? '{}',
      );
      content = textContent;
      if (imageKeys.length > 0 && this.client) {
        const groupPath = resolveGroupFolderPath(group.folder);
        for (const imageKey of imageKeys) {
          const p = await downloadMedia(
            this.client,
            msgId,
            'image',
            imageKey,
            groupPath,
          );
          if (p) content += `\n[Image: ${p}]`;
        }
      }
    } else if (
      msgType === 'image' ||
      msgType === 'file' ||
      msgType === 'audio'
    ) {
      if (this.client) {
        let fileKey = '';
        try {
          const parsed = JSON.parse(message.content ?? '{}');
          fileKey = toStr(parsed.image_key || parsed.file_key);
        } catch {
          // ignore parse error
        }
        const resourceType: 'image' | 'file' =
          msgType === 'image' ? 'image' : 'file';
        const groupPath = resolveGroupFolderPath(group.folder);
        const p = fileKey
          ? await downloadMedia(
              this.client,
              msgId,
              resourceType,
              fileKey,
              groupPath,
            )
          : null;
        content = p ? `[Downloaded: ${p}]` : `[${msgType}: unable to download]`;
      } else {
        content = `[${msgType}: unable to download]`;
      }
    } else {
      // text and other types — parse as { text }
      try {
        const parsed = JSON.parse(message.content ?? '{}');
        content = parsed.text ?? '';
      } catch {
        logger.debug({ msgId }, 'Feishu: non-text message ignored');
        return;
      }
    }

    // Fetch and prepend quoted message context when reply has a parent
    if (message.parent_id && this.client) {
      const quoted = await fetchQuotedMessage(this.client, message.parent_id);
      if (quoted) content = `[Quoted: ${quoted}]\n${content}`;
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

    if (group.requiresTrigger && !TRIGGER_PATTERN.test(content)) {
      logger.debug({ jid }, 'Feishu group message ignored (no trigger)');
      return;
    }

    this.lastMessageIdByJid[jid] = msgId;
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
    const replyMsgId = this.lastMessageIdByJid[jid];

    try {
      const chunks = splitMessage(text);
      for (const chunk of chunks) {
        const content = buildPostPayload(chunk);
        if (replyMsgId) {
          const res = await this.client.im.message.reply({
            path: { message_id: replyMsgId },
            data: { msg_type: 'post', content } as any,
          });
          // Fallback to create if the reply target message was withdrawn
          if (WITHDRAWN_REPLY_CODES.has((res as any)?.code)) {
            await this.client.im.message.create({
              data: { receive_id: receiveId, msg_type: 'post', content } as any,
              params: { receive_id_type: receiveIdType },
            });
          }
        } else {
          await this.client.im.message.create({
            data: { receive_id: receiveId, msg_type: 'post', content } as any,
            params: { receive_id_type: receiveIdType },
          });
        }
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

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;
    // Suppress typing calls during rate-limit backoff
    if (Date.now() < this.typingBackoffUntil) return;

    const messageId = this.lastMessageIdByJid[jid];
    if (!messageId) return;

    if (isTyping) {
      try {
        const res = await this.client.im.messageReaction.create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: 'Typing' } },
        });
        // SDK may return a response with a backoff code instead of throwing
        const resCode = (res as any)?.code;
        if (typeof resCode === 'number' && FEISHU_BACKOFF_CODES.has(resCode)) {
          this.typingBackoffUntil = Date.now() + this.TYPING_BACKOFF_MS;
          return;
        }
        const reactionId = (res as any)?.data?.reaction_id;
        if (reactionId) {
          this.lastReactionIdByJid[jid] = { messageId, reactionId };
        }
      } catch (err) {
        if (isBackoffError(err)) {
          this.typingBackoffUntil = Date.now() + this.TYPING_BACKOFF_MS;
          return;
        }
        logger.debug({ jid, err }, 'Feishu: failed to add typing reaction');
      }
    } else {
      const reaction = this.lastReactionIdByJid[jid];
      delete this.lastReactionIdByJid[jid];
      delete this.lastMessageIdByJid[jid];
      if (reaction) {
        try {
          const res = await this.client.im.messageReaction.delete({
            path: {
              message_id: reaction.messageId,
              reaction_id: reaction.reactionId,
            },
          });
          const resCode = (res as any)?.code;
          if (
            typeof resCode === 'number' &&
            FEISHU_BACKOFF_CODES.has(resCode)
          ) {
            this.typingBackoffUntil = Date.now() + this.TYPING_BACKOFF_MS;
          }
        } catch (err) {
          if (isBackoffError(err)) {
            this.typingBackoffUntil = Date.now() + this.TYPING_BACKOFF_MS;
            return;
          }
          logger.debug(
            { jid, err },
            'Feishu: failed to remove typing reaction',
          );
        }
      }
    }
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
