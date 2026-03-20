import fs from 'fs';
import path from 'path';
import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  MediaPayload,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/**
 * Wrap Markdown text in Feishu's native `md` tag for post format.
 * Feishu renders Markdown server-side, supporting bold, italic, code blocks
 * with syntax highlighting, quotes, lists, links, headings, etc.
 *
 * Note: md tag is send-only. Reading back messages returns converted tags.
 */
function markdownToMdPost(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text }]],
    },
  });
}

/**
 * Map file extension to Feishu file_type for the file upload API.
 */
function extensionToFeishuFileType(
  filename: string,
): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.opus':
    case '.ogg':
      return 'opus';
    case '.mp4':
      return 'mp4';
    case '.pdf':
      return 'pdf';
    case '.doc':
    case '.docx':
      return 'doc';
    case '.xls':
    case '.xlsx':
      return 'xls';
    case '.ppt':
    case '.pptx':
      return 'ppt';
    default:
      return 'stream';
  }
}

/**
 * Resolve media info from incoming message content.
 * Returns the file key, resource type, and filename for downloading.
 */
function resolveMediaInfo(
  msgType: string,
  parsed: any,
): { fileKey: string; resourceType: 'image' | 'file'; filename: string } | null {
  switch (msgType) {
    case 'image': {
      const imageKey = parsed.image_key;
      if (!imageKey) return null;
      return {
        fileKey: imageKey,
        resourceType: 'image',
        filename: `${imageKey}.jpg`,
      };
    }
    case 'file': {
      const fileKey = parsed.file_key;
      if (!fileKey) return null;
      return {
        fileKey,
        resourceType: 'file',
        filename: parsed.file_name || 'file',
      };
    }
    case 'audio': {
      const fileKey = parsed.file_key;
      if (!fileKey) return null;
      return { fileKey, resourceType: 'file', filename: 'audio.opus' };
    }
    case 'media': {
      const fileKey = parsed.file_key;
      if (!fileKey) return null;
      return {
        fileKey,
        resourceType: 'file',
        filename: parsed.file_name || 'video.mp4',
      };
    }
    default:
      return null;
  }
}

/** Media type label for agent content */
function mediaTypeLabel(msgType: string): string {
  switch (msgType) {
    case 'image':
      return 'Image';
    case 'file':
      return 'File';
    case 'audio':
      return 'Audio';
    case 'media':
      return 'Video';
    default:
      return 'File';
  }
}

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Lark.Client;
  private wsClient: Lark.WSClient | null = null;
  private opts: FeishuChannelOpts;
  private botOpenId: string = '';
  // Cache chat names to avoid repeated API calls
  private chatNameCache = new Map<string, string>();
  // Dedup: track recently seen message IDs to prevent duplicate processing
  private recentMsgIds = new Set<string>();

  constructor(appId: string, appSecret: string, opts: FeishuChannelOpts) {
    this.client = new Lark.Client({ appId, appSecret });
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Fetch bot info to get our own open_id for mention detection
    try {
      const botInfo: any = await this.client.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      });
      this.botOpenId = botInfo?.bot?.open_id || '';
      logger.info({ botOpenId: this.botOpenId }, 'Feishu bot info retrieved');
    } catch (err) {
      logger.warn(
        { err },
        'Failed to get Feishu bot info, mention detection may not work',
      );
    }

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
    });

    const { appId, appSecret } = this.client;

    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    await this.wsClient.start({ eventDispatcher });
    logger.info('Feishu bot connected');
    console.log('\n  Feishu bot connected via WebSocket');
    console.log("  Send /chatid to the bot to get a chat's registration ID\n");
  }

  private async handleMessage(data: any): Promise<void> {
    const message = data.message;
    if (!message) return;

    const chatId = message.chat_id;
    const chatType = message.chat_type; // 'group' or 'p2p'
    const msgType = message.message_type;
    const msgId = message.message_id;
    const rawContent = message.content || '{}';
    const mentions: any[] = message.mentions || [];
    const createTime = message.create_time; // millisecond timestamp string

    // Deduplicate: skip if we've already processed this message recently
    if (msgId && this.recentMsgIds.has(msgId)) {
      logger.debug({ msgId, chatId }, 'Duplicate Feishu event, skipping');
      return;
    }
    if (msgId) {
      this.recentMsgIds.add(msgId);
      setTimeout(() => this.recentMsgIds.delete(msgId), 10_000);
    }

    const chatJid = `feishu:${chatId}`;
    const timestamp = createTime
      ? new Date(parseInt(createTime, 10)).toISOString()
      : new Date().toISOString();

    // Extract sender info
    const senderId = data.sender?.sender_id?.open_id || '';
    const senderName = await this.getSenderName(data.sender, mentions);

    // Determine chat name
    const isGroup = chatType === 'group';
    let chatName: string;
    if (isGroup) {
      chatName = await this.getChatName(chatId);
    } else {
      chatName = senderName;
    }

    // Build content from message type
    let content = this.extractContent(msgType, rawContent, mentions);

    // Check for /chatid and /ping commands (text messages starting with /)
    if (msgType === 'text' && content.startsWith('/')) {
      const cmd = content.split(/\s/)[0].toLowerCase();
      if (cmd === '/chatid') {
        await this.sendMessage(
          chatJid,
          `Chat ID: feishu:${chatId}\nName: ${chatName}\nType: ${chatType}`,
        );
        return;
      }
      if (cmd === '/ping') {
        await this.sendMessage(chatJid, `${ASSISTANT_NAME} is online.`);
        return;
      }
    }

    // Translate @bot mentions into TRIGGER_PATTERN format
    if (this.botOpenId && mentions.length > 0) {
      const isBotMentioned = mentions.some(
        (m: any) => m.id?.open_id === this.botOpenId,
      );
      if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Report chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'feishu', isGroup);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Feishu chat',
      );
      return;
    }

    // Try to download media for supported message types
    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      parsed = {};
    }

    const mediaInfo = resolveMediaInfo(msgType, parsed);
    if (mediaInfo) {
      const containerPath = await this.downloadMessageResource(
        msgId,
        mediaInfo.fileKey,
        mediaInfo.resourceType,
        group.folder,
        mediaInfo.filename,
      );
      if (containerPath) {
        content = `[${mediaTypeLabel(msgType)}: ${containerPath}]`;
      }
      // If download fails, keep the original placeholder content
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Feishu message stored',
    );
  }

  /**
   * Download a media resource from a user message using messageResource.get.
   * Returns the container path if successful, null otherwise.
   */
  private async downloadMessageResource(
    msgId: string,
    fileKey: string,
    resourceType: 'image' | 'file',
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    try {
      const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
      fs.mkdirSync(mediaDir, { recursive: true });

      const safeFilename = `${msgId}_${filename}`.replace(/[^a-zA-Z0-9._-]/g, '_');
      const savePath = path.join(mediaDir, safeFilename);

      const resp = await Promise.race([
        this.client.im.v1.messageResource.get({
          path: { message_id: msgId, file_key: fileKey },
          params: { type: resourceType },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Media download timeout')), 10_000),
        ),
      ]);

      await (resp as any).writeFile(savePath);

      const containerPath = `/workspace/group/media/${safeFilename}`;
      logger.info(
        { msgId, fileKey, savePath, containerPath },
        'Media resource downloaded',
      );
      return containerPath;
    } catch (err) {
      logger.warn(
        { msgId, fileKey, err },
        'Failed to download media resource, using placeholder',
      );
      return null;
    }
  }

  private extractContent(
    msgType: string,
    rawContent: string,
    mentions: any[],
  ): string {
    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      parsed = {};
    }

    switch (msgType) {
      case 'text': {
        let text: string = parsed.text || '';
        // Replace @mention placeholders (e.g. @_user_1) with display names
        for (const m of mentions) {
          if (m.key && m.name) {
            text = text.replace(m.key, `@${m.name}`);
          }
        }
        return text;
      }
      case 'post':
        return this.extractPostText(parsed);
      case 'image':
        return '[Image]';
      case 'file':
        return `[File: ${parsed.file_name || 'file'}]`;
      case 'audio':
        return '[Audio]';
      case 'media':
        return '[Video]';
      case 'sticker':
        return '[Sticker]';
      case 'interactive':
        return '[Card]';
      case 'share_chat':
        return '[Shared Group]';
      case 'share_user':
        return '[Shared Contact]';
      case 'merge_forward':
        return '[Merge Forward]';
      default:
        return `[Unsupported: ${msgType}]`;
    }
  }

  private extractPostText(parsed: any): string {
    // Post (rich text) content has a nested structure: { title, content: [[{tag,text},...], ...] }
    const lang = parsed.zh_cn || parsed.en_us || parsed.ja_jp || Object.values(parsed)[0] as any;
    if (!lang) return '[Post]';
    const parts: string[] = [];
    if (lang.title) parts.push(lang.title);
    if (Array.isArray(lang.content)) {
      for (const line of lang.content) {
        if (!Array.isArray(line)) continue;
        for (const node of line) {
          if (node.tag === 'text' && node.text) parts.push(node.text);
          else if (node.tag === 'a' && node.text) parts.push(node.text);
          else if (node.tag === 'at' && node.user_name) parts.push(`@${node.user_name}`);
          else if (node.tag === 'img') parts.push('[Image]');
          else if (node.tag === 'media') parts.push('[Video]');
        }
      }
    }
    return parts.join(' ') || '[Post]';
  }

  private async getSenderName(sender: any, mentions: any[]): Promise<string> {
    // Try to get name from mentions (if sender mentioned themselves or bot knows)
    const senderId = sender?.sender_id?.open_id;
    if (!senderId) return 'Unknown';

    // Try fetching user info via API
    try {
      const resp = await this.client.contact.v3.user.get({
        path: { user_id: senderId },
        params: { user_id_type: 'open_id' },
      });
      const name = (resp as any)?.data?.user?.name || (resp as any)?.user?.name;
      if (name) return name;
    } catch (err) {
      logger.warn({ err, senderId }, 'Failed to get Feishu user name');
    }

    // Fallback to sender open_id
    return senderId;
  }

  private async getChatName(chatId: string): Promise<string> {
    const cached = this.chatNameCache.get(chatId);
    if (cached) return cached;

    try {
      const resp = await this.client.im.v1.chat.get({
        path: { chat_id: chatId },
      });
      const name = (resp as any)?.data?.name || (resp as any)?.name;
      if (name) {
        this.chatNameCache.set(chatId, name);
        return name;
      }
    } catch {
      // Fall through
    }

    return chatId;
  }

  /**
   * Check if text contains Markdown formatting that would benefit from post format.
   */
  private hasMarkdown(text: string): boolean {
    // Check for common Markdown patterns
    const markdownPatterns = [
      /\*\*[^*]+\*\*/,       // **bold**
      /__[^_]+__/,           // __bold__
      /\*[^*]+\*/,           // *italic*
      /_[^_]+_/,             // _italic_
      /~~[^~]+~~/,           // ~~strikethrough~~
      /`[^`]+`/,             // `code`
      /\[[^\]]+\]\([^)]+\)/, // [link](url)
      /^#{1,6}\s/,           // # heading
      /^[-*+]\s/,            // - list item
      /^\d+\.\s/,            // 1. list item
      /^>\s/,                // > quote
      /^```/,                // code block
    ];
    return markdownPatterns.some(p => p.test(text));
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.wsClient) {
      logger.warn('Feishu bot not initialized');
      return;
    }

    try {
      const chatId = jid.replace(/^feishu:/, '');

      // Use post format for messages with Markdown, plain text otherwise
      if (this.hasMarkdown(text)) {
        const postContent = markdownToMdPost(text);
        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            content: postContent,
            msg_type: 'post',
          },
        });
        logger.info({ jid, length: text.length, format: 'post' }, 'Feishu message sent');
      } else {
        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            content: JSON.stringify({ text }),
            msg_type: 'text',
          },
        });
        logger.info({ jid, length: text.length, format: 'text' }, 'Feishu message sent');
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  async sendMedia(jid: string, media: MediaPayload): Promise<void> {
    const chatId = jid.replace(/^feishu:/, '');

    try {
      switch (media.type) {
        case 'image': {
          const resp = await this.client.im.v1.image.create({
            data: {
              image_type: 'message',
              image: fs.createReadStream(media.filePath),
            },
          } as any);
          const imageKey = (resp as any)?.image_key || (resp as any)?.data?.image_key;
          if (!imageKey) {
            logger.error({ jid }, 'Image upload returned no key');
            return;
          }
          await this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content: JSON.stringify({ image_key: imageKey }),
              msg_type: 'image',
            },
          });
          logger.info({ jid, imageKey }, 'Feishu image sent');
          break;
        }
        case 'audio': {
          const resp = await this.client.im.v1.file.create({
            data: {
              file_type: 'opus',
              file_name: media.filename || 'audio.opus',
              file: fs.createReadStream(media.filePath),
            },
          } as any);
          const fileKey = (resp as any)?.file_key || (resp as any)?.data?.file_key;
          if (!fileKey) {
            logger.error({ jid }, 'Audio upload returned no key');
            return;
          }
          await this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content: JSON.stringify({ file_key: fileKey }),
              msg_type: 'audio',
            },
          });
          logger.info({ jid, fileKey }, 'Feishu audio sent');
          break;
        }
        default: {
          // 'file' and 'video' (video downgrades to file since media type needs cover image)
          const fname = media.filename || path.basename(media.filePath);
          const fileType = media.type === 'video'
            ? 'stream'
            : extensionToFeishuFileType(fname);
          const resp = await this.client.im.v1.file.create({
            data: {
              file_type: fileType,
              file_name: fname,
              file: fs.createReadStream(media.filePath),
            },
          } as any);
          const fileKey = (resp as any)?.file_key || (resp as any)?.data?.file_key;
          if (!fileKey) {
            logger.error({ jid }, 'File upload returned no key');
            return;
          }
          await this.client.im.v1.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content: JSON.stringify({ file_key: fileKey }),
              msg_type: 'file',
            },
          });
          logger.info({ jid, fileKey, fileType }, 'Feishu file sent');
        }
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send media');
    }
  }

  isConnected(): boolean {
    return this.wsClient !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient = null;
      logger.info('Feishu bot stopped');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu does not support typing indicators
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
