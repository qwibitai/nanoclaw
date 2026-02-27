import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { GROUPS_DIR } from '../config.js';

export interface FeishuChannelOpts {
  appId: string;
  appSecret: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => Promise<void>;
  mainGroupFolder?: string;
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Client;
  private wsClient: WSClient | null = null;
  private opts: FeishuChannelOpts;
  private connected = false;
  // Track active reactions per chat: chatJid -> Set of {messageId, reactionId}
  private activeReactions: Map<string, Set<{ messageId: string; reactionId: string }>> = new Map();
  // Track last message info per chat for reply context: chatJid -> {messageId, isGroup}
  private lastMessageInfo: Map<string, { messageId: string; isGroup: boolean }> = new Map();
  // Track processed event IDs to prevent duplicate processing (Feishu may send duplicate events)
  private processedEvents: Set<string> = new Set();
  private readonly MAX_PROCESSED_EVENTS = 1000;

  constructor(opts: FeishuChannelOpts) {
    this.opts = opts;
    this.client = new Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: 'https://open.feishu.cn',
    });
  }

  /**
   * Add a reaction emoji to a message
   * @param messageId The message ID to react to
   * @param emojiType The emoji type (e.g., 'THUMBSUP', 'OK')
   * @returns The reaction ID for later removal
   */
  private async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const response = await this.client.im.messageReaction.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
      });
      logger.info({ messageId, emojiType, reactionId: response?.data?.reaction_id }, 'Feishu: added reaction');
      return response?.data?.reaction_id || null;
    } catch (error) {
      logger.error({ messageId, emojiType, error }, 'Feishu: failed to add reaction');
      return null;
    }
  }

  /**
   * Remove a reaction from a message
   * @param messageId The message ID
   * @param reactionId The reaction ID to remove
   */
  private async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.client.im.messageReaction.delete({
        path: {
          message_id: messageId,
          reaction_id: reactionId,
        },
      });
      logger.info({ messageId, reactionId }, 'Feishu: removed reaction');
    } catch (error) {
      logger.error({ messageId, reactionId, error }, 'Feishu: failed to remove reaction');
    }
  }

  async connect(): Promise<void> {
    logger.info('Connecting to Feishu...');

    // Create EventDispatcher to handle incoming messages
    const eventDispatcher = new EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
    });

    // Create WSClient with app credentials
    this.wsClient = new WSClient({
      appId: this.opts.appId,
      appSecret: this.opts.appSecret,
      domain: 'https://open.feishu.cn',
    });

    // Start the WebSocket connection with event handler
    this.wsClient.start({
      eventDispatcher,
    });

    this.connected = true;
    logger.info('Feishu channel connected');
  }

  private async handleMessage(data: any): Promise<void> {
    try {
      // Deduplicate events using event_id (Feishu may send duplicate events)
      const eventId = data.event_id;
      if (eventId) {
        if (this.processedEvents.has(eventId)) {
          logger.debug({ eventId }, 'Feishu: skipping duplicate event');
          return;
        }
        // Add to processed events set, with cleanup to prevent memory leak
        this.processedEvents.add(eventId);
        if (this.processedEvents.size > this.MAX_PROCESSED_EVENTS) {
          // Remove oldest entries when exceeding limit
          const entries = Array.from(this.processedEvents);
          const toRemove = entries.slice(0, 100);
          for (const e of toRemove) {
            this.processedEvents.delete(e);
          }
        }
      }

      // Debug log for all received messages
      logger.info({ data: JSON.stringify(data) }, 'Feishu: received message event raw');

      const message = data.message;
      const sender = data.sender;
      const chatType = message.chat_type;
      const messageId = message.message_id;

      logger.info({ chatType, senderOpenId: sender?.sender_id?.open_id, messageId }, 'Feishu: parsed message info');

      // Get message content (text only for now)
      let content = '';
      const messageType = message.message_type;

      if (messageType === 'text') {
        const contentObj = JSON.parse(message.content);
        content = contentObj.text || '';
      } else if (messageType === 'post') {
        // Handle post messages (rich text)
        const contentObj = JSON.parse(message.content);
        // Extract text from post content
        const post = contentObj.post;
        if (post && post.zh_cn) {
          content = this.extractTextFromPost(post.zh_cn);
        }
      }

      // Skip empty messages
      if (!content) return;

      // Build chat JID - both p2p and group use chat_id
      // p2p (private chat): chat_id starts with "oc_"
      // group: chat_id starts with "oc_"
      const chatJid = `feishu:${message.chat_id}`;

      logger.info({ chatJid, registeredJids: Object.keys(this.opts.registeredGroups()) }, 'Feishu: chat JID info');

      // Get timestamp
      const timestamp = new Date(message.create_time * 1000).toISOString();

      // Get sender info
      const senderName = sender.sender_id.name || 'Unknown';
      const senderId = sender.sender_id.open_id || '';

      // Store chat metadata
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', chatType === 'group');

      // Only deliver full message for registered chats
      let group = this.opts.registeredGroups()[chatJid];
      logger.info({ chatJid, groupExists: !!group, chatType, hasRegisterCallback: !!this.opts.registerGroup }, 'Feishu: checking chat registration');
      if (!group) {
        // Auto-register p2p (private) chats if registerGroup callback is provided
        if (chatType === 'p2p' && this.opts.registerGroup) {
          logger.info({ chatJid, senderId }, 'Feishu: auto-registering new private chat');

          // Generate unique folder name for each p2p chat to avoid conflicts
          // Use sender's open_id suffix to create unique folder
          const senderSuffix = senderId.slice(-8);
          const folderName = `p2p-${senderSuffix}`;
          const newGroup: RegisteredGroup = {
            name: `Private Chat ${senderSuffix}`,
            folder: folderName,
            trigger: '@Andy',
            added_at: timestamp,
            requiresTrigger: false, // Private chats don't require trigger
          };

          try {
            await this.opts.registerGroup(chatJid, newGroup);
            logger.info({ chatJid, folder: folderName, senderId }, 'Feishu: auto-registered private chat');

            // Create CLAUDE.md for the new private chat to prevent duplicate messages
            this.createClaudeMdForGroup(folderName);

            // Re-fetch the registered groups to get the newly registered one
            group = this.opts.registeredGroups()[chatJid];
          } catch (error) {
            logger.error({ chatJid, folder: folderName, error }, 'Feishu: failed to auto-register private chat');
            return;
          }
        } else {
          logger.debug(`Feishu: ignoring message from unregistered chat ${chatJid}`);
          return;
        }
      }

      // Store message info for reply context (used in group chats)
      this.lastMessageInfo.set(chatJid, { messageId, isGroup: chatType === 'group' });

      // Add "typing" reaction to indicate processing
      const reactionId = await this.addReaction(messageId, 'Typing');
      if (reactionId) {
        // Store reaction per chat for later cleanup
        if (!this.activeReactions.has(chatJid)) {
          this.activeReactions.set(chatJid, new Set());
        }
        this.activeReactions.get(chatJid)!.add({ messageId, reactionId });
      }

      // Create NewMessage object
      const newMessage: NewMessage = {
        id: messageId,
        chat_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content: content,
        timestamp: timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      this.opts.onMessage(chatJid, newMessage);
    } catch (error) {
      logger.error({ error }, 'Error handling Feishu message');
    }
  }

  private extractTextFromPost(post: any): string {
    let text = '';
    const content = post.content || [];
    for (const block of content) {
      for (const item of block) {
        if (item.tag === 'text') {
          text += item.text;
        } else if (item.tag === 'at') {
          text += `@${item.mention_name || 'user'} `;
        }
      }
    }
    return text;
  }

  /**
   * Create CLAUDE.md for a newly registered group to prevent duplicate messages.
   * This file explicitly tells the agent not to use mcp__nanoclaw__send_message tool.
   */
  private createClaudeMdForGroup(folderName: string): void {
    try {
      const groupDir = path.join(GROUPS_DIR, folderName);
      fs.mkdirSync(groupDir, { recursive: true });

      const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
      if (fs.existsSync(claudeMdPath)) {
        // CLAUDE.md already exists, don't overwrite
        return;
      }

      const claudeMdContent = `# Feishu Assistant

你是 Feishu (飞书) 上的智能助手。

## 通信方式 (重要)

**只使用标准输出发送消息**。

不要使用 \`mcp__nanoclaw__send_message\` 工具。你的所有输出都会通过标准输出自动发送给用户。

## 功能

- 回答问题并进行对话
- 搜索网页和获取 URL 内容
- **浏览网页** 使用 \`agent-browser\` — 打开页面、点击、填写表单、截图、提取数据（运行 \`agent-browser open <url>\` 开始，然后 \`agent-browser snapshot -i\` 查看可交互元素）
- 读写工作区文件
- 运行 bash 命令
- 安排稍后运行或定期运行的任务

## Feishu 消息格式化

飞书支持 Markdown 格式，你可以使用：
- **粗体** (**text**)
- *斜体* (*text*)
- \`代码\` (\`code\`)
- [链接](url)
- 表情符号 (如 [比心])

## 内部思考

如果部分内容只是内部推理而非给用户看的内容，使用 \`<internal>\` 标签包裹：

\`\`\`
<internal>这是一个内部思考，不会发送给用户</internal>

这是给用户的回复内容...
\`\`\`

\`<internal>\` 标签内的文本会被记录但不会发送给用户。

## 记忆

\`conversations/\` 文件夹包含过去对话的可搜索历史。使用它来回忆之前会话的上下文。

当你学到重要信息时：
- 为结构化数据创建文件（例如 \`customers.md\`、\`preferences.md\`）
- 将超过 500 行的文件拆分为文件夹
- 在你创建的文件中保持索引
`;

      fs.writeFileSync(claudeMdPath, claudeMdContent, 'utf-8');
      logger.info({ folderName, claudeMdPath }, 'Feishu: created CLAUDE.md for new group');
    } catch (error) {
      logger.error({ folderName, error }, 'Feishu: failed to create CLAUDE.md for new group');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Check if we have message context for reply
    const messageInfo = this.lastMessageInfo.get(jid);

    logger.info({ jid, hasMessageInfo: !!messageInfo, isGroup: messageInfo?.isGroup, messageId: messageInfo?.messageId }, 'Feishu: sendMessage called');

    // Use reply in group chats, normal send in p2p chats
    // NOTE: We don't clear lastMessageInfo here to allow multiple streaming outputs
    // to use the same message context. State is cleared when markProcessingComplete is called.
    if (messageInfo?.isGroup && messageInfo.messageId) {
      try {
        logger.info({ jid, messageId: messageInfo.messageId }, 'Feishu: using reply for group chat');
        await this.replyToMessage(messageInfo.messageId, text);
        return;
      } catch (error) {
        logger.warn({ jid, error }, 'Feishu: reply failed, falling back to normal send');
        // Fallback to normal send
      }
    }

    // For p2p chats or fallback from reply, use normal message
    await this.sendNormalMessage(jid, text);
  }

  /**
   * Mark message processing as complete and clear related state.
   * This should be called after the agent finishes processing a message.
   * It clears typing indicators and message context to prepare for the next message.
   */
  async markProcessingComplete(jid: string): Promise<void> {
    logger.info({ jid }, 'Feishu: marking processing complete');

    // Clear typing reaction for this chat (Typing indicator should be removed after response)
    const reactions = this.activeReactions.get(jid);
    if (reactions && reactions.size > 0) {
      logger.info({ jid, count: reactions.size }, 'Feishu: clearing typing reactions on processing complete');
      for (const { messageId, reactionId } of reactions) {
        await this.removeReaction(messageId, reactionId);
      }
      this.activeReactions.delete(jid);
    }

    // Clear last message info
    this.lastMessageInfo.delete(jid);

    logger.info({ jid }, 'Feishu: processing complete, state cleared');
  }

  /**
   * Send a normal message (for p2p chats or when no reply context)
   */
  private async sendNormalMessage(jid: string, text: string): Promise<void> {
    // Extract ID from JID
    const id = jid.replace('feishu:', '');

    // Determine if it's a chat_id (group) or open_id (personal)
    const isChatId = id.startsWith('oc_');
    const receiveIdType = isChatId ? 'chat_id' : 'open_id';

    try {
      await this.client.im.message.create({
        params: {
          receive_id_type: receiveIdType,
        },
        data: {
          receive_id: id,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      logger.info(`Feishu: message sent to ${jid} (type: ${receiveIdType})`);
    } catch (error) {
      logger.error({ jid, error }, 'Feishu: failed to send message');
      throw error;
    }
  }

  /**
   * Reply to a specific message (for group chats)
   * This creates a threaded reply that shows the original message context
   */
  private async replyToMessage(messageId: string, text: string): Promise<void> {
    await this.client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        msg_type: 'text',
        content: JSON.stringify({ text }),
        reply_in_thread: false, // Reply as normal threaded message, not as topic
      },
    });
    logger.info({ messageId }, 'Feishu: replied to message');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  /**
   * Set typing indicator by managing message reactions
   * When isTyping=true, reactions are already added by handleMessage
   * When isTyping=false, remove all active reactions for this chat
   */
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    logger.info({ jid, isTyping, activeReactions: this.activeReactions.has(jid) }, 'Feishu: setTyping called');

    if (isTyping) {
      // Reactions are already added by handleMessage when messages arrive
      return;
    }

    // Remove all reactions for this chat when done processing
    const reactions = this.activeReactions.get(jid);
    if (reactions && reactions.size > 0) {
      logger.info({ jid, count: reactions.size }, 'Feishu: removing typing reactions');
      for (const { messageId, reactionId } of reactions) {
        await this.removeReaction(messageId, reactionId);
      }
      this.activeReactions.delete(jid);
    } else {
      logger.info({ jid, hasEntry: this.activeReactions.has(jid) }, 'Feishu: no reactions to remove');
    }
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      this.wsClient.close();
      this.wsClient = null;
      this.connected = false;
      logger.info('Feishu channel disconnected');
    }
  }
}
