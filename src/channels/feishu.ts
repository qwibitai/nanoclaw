/**
 * Feishu (Lark) channel for NanoClaw.
 *
 * Connects via WebSocket long-connection (no public server needed).
 * Uses the official @larksuiteoapi/node-sdk.
 *
 * Environment variables:
 *   FEISHU_APP_ID     - Feishu app ID from open platform
 *   FEISHU_APP_SECRET - Feishu app secret
 *   FEISHU_DOMAIN     - Optional: "feishu" (default) or "lark" for international
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import * as Lark from '@larksuiteoapi/node-sdk';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type { Channel, NewMessage } from '../types.js';
import type { ChannelOpts } from './registry.js';
import { registerChannel } from './registry.js';

const JID_PREFIX = 'fs:';
const TEXT_CHUNK_LIMIT = 4000;
const IMAGE_TAG_RE = /\[IMAGE:(\/[^\]]+\.(?:png|jpg|jpeg|gif|webp|bmp|tiff|ico))\]/gi;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB Feishu limit
const IMAGE_UPLOAD_DIR = '/workspace/ipc/uploads';

/** Deduplicate messages by ID (simple LRU set). */
const seenMessages = new Set<string>();
const MAX_SEEN = 500;

function isDuplicate(messageId: string | undefined): boolean {
  if (!messageId) return false;
  if (seenMessages.has(messageId)) return true;
  seenMessages.add(messageId);
  if (seenMessages.size > MAX_SEEN) {
    const first = seenMessages.values().next().value;
    if (first !== undefined) seenMessages.delete(first);
  }
  return false;
}

/** Resolve receive_id_type from Feishu ID prefix. */
function resolveReceiveIdType(
  id: string,
): 'chat_id' | 'open_id' | 'union_id' {
  if (id.startsWith('ou_')) return 'open_id';
  if (id.startsWith('on_')) return 'union_id';
  return 'chat_id';
}

/** Split long text into chunks respecting newlines and spaces. */
function chunkText(text: string, limit: number = TEXT_CHUNK_LIMIT): string[] {
  if (!text || text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const lastNewline = window.lastIndexOf('\n');
    const lastSpace = window.lastIndexOf(' ');
    let breakIdx = lastNewline > 0 ? lastNewline : lastSpace;
    if (breakIdx <= 0) breakIdx = limit;
    const chunk = remaining.slice(0, breakIdx).trimEnd();
    if (chunk.length > 0) chunks.push(chunk);
    const brokeOnSep =
      breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    remaining = remaining
      .slice(breakIdx + (brokeOnSep ? 1 : 0))
      .trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

class FeishuChannel implements Channel {
  name = 'feishu';
  private client: InstanceType<typeof Lark.Client>;
  private wsClient: InstanceType<typeof Lark.WSClient> | null = null;
  private connected = false;
  private opts: ChannelOpts;
  private appId: string;
  private appSecret: string;
  private domain: string;

  constructor(
    opts: ChannelOpts,
    appId: string,
    appSecret: string,
    domain: string,
  ) {
    this.opts = opts;
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = domain;

    this.client = new Lark.Client({
      appId,
      appSecret,
      domain:
        domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      appType: Lark.AppType.SelfBuild,
    });
  }

  async connect(): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: unknown) => {
        this.handleMessage(data as Record<string, unknown>).catch((err) => {
          logger.error(
            { err, channel: 'feishu' },
            'Feishu message handler error',
          );
        });
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain:
        this.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    this.wsClient.start({ eventDispatcher: dispatcher });
    this.connected = true;
    logger.info(
      { channel: 'feishu', domain: this.domain },
      'Feishu WebSocket client started',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.startsWith(JID_PREFIX) ? jid.slice(JID_PREFIX.length) : jid;
    if (!chatId.trim()) return;

    // Extract image tags and split text into segments
    const segments = this.parseImageSegments(text);

    for (const segment of segments) {
      if (segment.type === 'image') {
        await this.sendImageFile(chatId.trim(), segment.path!);
      } else if (segment.text) {
        const chunks = chunkText(segment.text);
        for (const chunk of chunks) {
          await this.sendTextMessage(chatId.trim(), chunk);
        }
      }
    }
  }

  /**
   * Parse text into segments of text and image tags.
   * Image tags use the format: [IMAGE:/absolute/path/to/file.png]
   */
  private parseImageSegments(
    text: string,
  ): Array<{ type: 'text' | 'image'; text?: string; path?: string }> {
    const segments: Array<{
      type: 'text' | 'image';
      text?: string;
      path?: string;
    }> = [];
    let lastIndex = 0;

    // Reset regex state for global matching
    IMAGE_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_TAG_RE.exec(text)) !== null) {
      // Add preceding text if any
      const before = text.slice(lastIndex, match.index).trim();
      if (before) {
        segments.push({ type: 'text', text: before });
      }
      segments.push({ type: 'image', path: match[1] });
      lastIndex = match.index + match[0].length;
    }

    // Add remaining text
    const remaining = text.slice(lastIndex).trim();
    if (remaining) {
      segments.push({ type: 'text', text: remaining });
    }

    // If no images found, return original text as single segment
    if (segments.length === 0 && text.trim()) {
      segments.push({ type: 'text', text: text.trim() });
    }

    return segments;
  }

  /** Upload a local image file and send it as an image message. */
  private async sendImageFile(chatId: string, filePath: string): Promise<void> {
    try {
      // Validate file exists and is within size limit
      if (!fs.existsSync(filePath)) {
        logger.warn(
          { channel: 'feishu', filePath },
          'Image file not found, sending path as text',
        );
        await this.sendTextMessage(chatId, `[Image not found: ${filePath}]`);
        return;
      }

      const stat = fs.statSync(filePath);
      if (stat.size === 0 || stat.size > MAX_IMAGE_SIZE) {
        logger.warn(
          { channel: 'feishu', filePath, size: stat.size },
          'Image file size invalid (0 or >10MB)',
        );
        await this.sendTextMessage(
          chatId,
          `[Image too large or empty: ${filePath}]`,
        );
        return;
      }

      // Upload image to Feishu (SDK expects a ReadStream for multipart/form-data)
      const uploadRes = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(filePath),
        },
      });

      const imageKey = uploadRes?.image_key;
      if (!imageKey) {
        logger.error(
          { channel: 'feishu', filePath, uploadRes },
          'Failed to upload image: no image_key returned',
        );
        await this.sendTextMessage(
          chatId,
          `[Image upload failed: ${filePath}]`,
        );
        return;
      }

      logger.info(
        { channel: 'feishu', filePath, imageKey },
        'Image uploaded successfully',
      );

      // Send image message
      await this.client.im.message.create({
        params: { receive_id_type: resolveReceiveIdType(chatId) },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });
    } catch (err) {
      logger.error(
        { err, channel: 'feishu', chatId, filePath },
        'Failed to send Feishu image',
      );
      // Fallback: send path as text so the user knows something went wrong
      await this.sendTextMessage(
        chatId,
        `[Image send failed: ${filePath}]`,
      ).catch(() => {});
    }
  }

  /** Send a plain text message. */
  private async sendTextMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.message.create({
        params: { receive_id_type: resolveReceiveIdType(chatId) },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      logger.error(
        { err, channel: 'feishu', chatId },
        'Failed to send Feishu message',
      );
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.wsClient = null;
    logger.info({ channel: 'feishu' }, 'Feishu channel disconnected');
  }

  /** Download an image from a Feishu message and save it locally. */
  private async downloadMessageImage(
    messageId: string,
    imageKey: string,
  ): Promise<string | null> {
    try {
      fs.mkdirSync(IMAGE_UPLOAD_DIR, { recursive: true });
      const ext = 'png';
      const filename = `feishu_${Date.now()}_${imageKey.slice(-8)}.${ext}`;
      const filePath = path.join(IMAGE_UPLOAD_DIR, filename);

      const resp = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      });

      // SDK returns a readable stream or Buffer — handle both
      const raw = resp as unknown;
      if (Buffer.isBuffer(raw)) {
        fs.writeFileSync(filePath, raw);
      } else if (raw && typeof (raw as { pipe?: unknown }).pipe === 'function') {
        await new Promise<void>((resolve, reject) => {
          const stream = raw as NodeJS.ReadableStream;
          const out = fs.createWriteStream(filePath);
          stream.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
          stream.on('error', reject);
        });
      } else {
        // Try treating as response with writeFile helper from SDK
        const writeFile = (resp as { writeFile?: (p: string) => Promise<void> }).writeFile;
        if (typeof writeFile === 'function') {
          await writeFile(filePath);
        } else {
          logger.warn({ channel: 'feishu', imageKey }, 'Unknown image response type, cannot save');
          return null;
        }
      }

      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        fs.unlinkSync(filePath);
        logger.warn({ channel: 'feishu', imageKey }, 'Downloaded image is empty');
        return null;
      }

      logger.info({ channel: 'feishu', filePath, size: stat.size }, 'Feishu image downloaded');
      return filePath;
    } catch (err) {
      logger.error({ err, channel: 'feishu', messageId, imageKey }, 'Failed to download Feishu image');
      return null;
    }
  }

  /** Handle an incoming Feishu message event. */
  private async handleMessage(data: Record<string, unknown>): Promise<void> {
    const message = (data as { message?: Record<string, unknown> }).message;
    if (!message) return;

    const chatId = message.chat_id as string | undefined;
    if (!chatId) return;

    const messageId = message.message_id as string | undefined;
    if (isDuplicate(messageId)) return;

    const messageType = message.message_type as string | undefined;
    if (!message.content || !messageType) return;

    const chatType = message.chat_type as string | undefined;
    const sender = (data as { sender?: { sender_id?: { open_id?: string } } })
      .sender;
    const senderId = sender?.sender_id?.open_id ?? '';
    const jid = `${JID_PREFIX}${chatId}`;
    const timestamp = new Date().toISOString();

    let text = '';

    if (messageType === 'text') {
      // ── Text message ──────────────────────────────────────────
      try {
        const parsed = JSON.parse(message.content as string) as { text?: string };
        text = (parsed.text ?? '').trim();
      } catch {
        return;
      }
      if (!text) return;

      // In group chats, strip @mention placeholders
      if (chatType === 'group') {
        text = text.replace(/@_user_\d+\s*/g, '').trim();
        if (!text) return;
      }

    } else if (messageType === 'image') {
      // ── Image message ─────────────────────────────────────────
      let imageKey: string | undefined;
      try {
        const parsed = JSON.parse(message.content as string) as { image_key?: string };
        imageKey = parsed.image_key;
      } catch {
        return;
      }
      if (!imageKey || !messageId) return;

      logger.info({ channel: 'feishu', messageId, imageKey }, 'Feishu image message received, downloading...');
      const filePath = await this.downloadMessageImage(messageId, imageKey);
      if (filePath) {
        text = `[用户发送了一张图片]\n图片路径: ${filePath}\n请使用 Read 工具查看该图片。`;
      } else {
        text = '[用户发送了一张图片，但下载失败，请重新发送]';
      }

    } else {
      // Unsupported message type — ignore silently
      return;
    }

    logger.debug(
      { channel: 'feishu', chatId, senderId, messageType, textLength: text.length },
      'Feishu message received',
    );

    const msg: NewMessage = {
      id: messageId ?? `fs_${Date.now()}`,
      chat_jid: jid,
      sender: senderId,
      sender_name: '',
      content: text,
      timestamp,
      is_from_me: false,
    };

    // onChatMetadata must come first — it creates the chat record in SQLite
    // that onMessage's storeMessage references via foreign key.
    this.opts.onChatMetadata(
      jid,
      timestamp,
      undefined,
      'feishu',
      chatType === 'group',
    );
    this.opts.onMessage(jid, msg);
  }
}

// --- Self-registration ---
// The channel is automatically enabled when FEISHU_APP_ID is set.
// Reads from .env file (via readEnvFile) with process.env fallback,
// matching NanoClaw's convention of not leaking secrets into process.env.
registerChannel('feishu', (opts) => {
  const envCfg = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_DOMAIN',
  ]);
  const appId = (process.env.FEISHU_APP_ID ?? envCfg.FEISHU_APP_ID)?.trim();
  const appSecret = (
    process.env.FEISHU_APP_SECRET ?? envCfg.FEISHU_APP_SECRET
  )?.trim();
  if (!appId || !appSecret) return null;

  const domain = (
    process.env.FEISHU_DOMAIN ??
    envCfg.FEISHU_DOMAIN ??
    'feishu'
  ).toLowerCase();
  return new FeishuChannel(opts, appId, appSecret, domain);
});
