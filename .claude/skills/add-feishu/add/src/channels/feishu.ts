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
