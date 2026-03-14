import axios from 'axios';
import { DWClient, TOPIC_ROBOT, RobotMessage, EventAck } from 'dingtalk-stream';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { setRegisteredGroup, getRegisteredGroup } from '../db.js';
import { resolveGroupFolderPath, isValidGroupFolder } from '../group-folder.js';
import fs from 'fs';
import path from 'path';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DingTalkChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Map conversationId to sessionWebhook for sending replies
type SessionWebhookMap = Map<string, string>;

// Map conversationId to pending commands (for confirmation flow)
type PendingCommand = { type: string; timestamp: number };
type PendingCommandsMap = Map<string, PendingCommand>;

/**
 * DingTalk Channel using Stream Mode SDK
 * @see https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs
 */
export class DingTalkChannel implements Channel {
  name = 'dingtalk';

  private client: DWClient | null = null;
  private opts: DingTalkChannelOpts;
  private clientId: string;
  private clientSecret: string;
  private sessionWebhooks: SessionWebhookMap = new Map();
  private pendingCommands: PendingCommandsMap = new Map();

  constructor(
    clientId: string,
    clientSecret: string,
    opts: DingTalkChannelOpts,
  ) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new DWClient({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      debug: process.env.DINGTALK_DEBUG === 'true',
    });

    // Register robot message listener
    this.client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
      try {
        const message = JSON.parse(res.data) as RobotMessage;
        await this.handleRobotMessage(message);
      } catch (err) {
        logger.error({ err }, 'Failed to parse DingTalk message');
      }
    });

    // Register all-event listener for ack
    this.client.registerAllEventListener((message) => {
      return { status: EventAck.SUCCESS };
    });

    // Start connection
    // Note: dingtalk-stream SDK doesn't emit a 'connect' event, but the connection
    // succeeds quickly. We use a short delay to ensure the WebSocket is ready.
    this.client.connect();
    await new Promise((resolve) => setTimeout(resolve, 1000));

    logger.info('DingTalk bot connected');
  }

  private async handleRobotMessage(message: RobotMessage): Promise<void> {
    const {
      conversationId,
      senderStaffId,
      senderNick,
      conversationType,
      sessionWebhook,
      msgtype,
      text,
      msgId,
      createAt,
    } = message;

    // Store sessionWebhook for sending replies
    this.sessionWebhooks.set(conversationId, sessionWebhook);

    const chatJid = `dingtalk:${conversationId}`;
    const timestamp = new Date(createAt).toISOString();
    const senderName = senderNick || senderStaffId;
    const isGroup = conversationType === 'group' || conversationType === '2';

    // Store chat metadata
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      undefined,
      'dingtalk',
      isGroup,
    );

    // Check if registered
    const group = this.opts.registeredGroups()[chatJid];

    // Handle commands (work even for unregistered groups)
    if (msgtype === 'text' && text?.content) {
      const content = text.content.trim();

      // /chatid command
      if (content === '/chatid' || content === '！chatid') {
        const registeredStatus = group ? `已注册: ${group.name}` : '未注册';
        await this.sendMessage(
          chatJid,
          `Chat ID: \`${chatJid}\`\nConversation ID: ${conversationId}\nType: ${isGroup ? 'Group' : 'Private'}\n状态: ${registeredStatus}`,
        );
        return;
      }

      // /register command - show usage
      if (content === '/register' || content === '！register') {
        if (group) {
          await this.sendMessage(
            chatJid,
            `此群聊已注册！\n名称: ${group.name}\n文件夹: ${group.folder}\n触发器: ${group.trigger}`,
          );
        } else {
          await this.sendMessage(chatJid, this.getRegisterHelp());
        }
        return;
      }

      // /register command - parse and execute
      if (
        content.startsWith('/register ') ||
        content.startsWith('！register ')
      ) {
        const isExclamation = content.startsWith('！');
        const argsContent = content.substring(isExclamation ? 10 : 9).trim();
        await this.handleRegisterCommand(chatJid, argsContent);
        return;
      }

      // /ping command
      if (content === '/ping' || content === '！ping') {
        await this.sendMessage(chatJid, `${ASSISTANT_NAME} is online.`);
        return;
      }
    }

    // If not registered and not a command, ignore
    if (!group) {
      logger.debug(
        { chatJid, conversationId },
        'Message from unregistered DingTalk conversation',
      );
      return;
    }

    // Commands that require the group to be registered
    if (msgtype === 'text' && text?.content) {
      const content = text.content.trim();

      // /set-main command - set current group as a main group
      if (content === '/set-main' || content === '！设置主群') {
        if (group.isMain) {
          await this.sendMessage(
            chatJid,
            `此群已经是主群了。\n\n名称：${group.name}\n文件夹：${group.folder}`,
          );
        } else {
          // Require explicit confirmation
          await this.sendMessage(
            chatJid,
            `⚠️ 即将把此群设置为主群。\n\n主群特权：\n• 可以看到所有群的任务\n• 可以管理其他群组\n\n发送 /set-main-confirm 确认，或 /cancel 取消`,
          );
          // Store pending command in session (using timestamp as key)
          this.pendingCommands.set(conversationId, {
            type: 'set-main',
            timestamp: Date.now(),
          });
        }
        return;
      }

      // /set-main-confirm command
      if (content === '/set-main-confirm' || content === '！确认设置主群') {
        const pending = this.pendingCommands.get(conversationId);
        if (
          pending?.type === 'set-main' &&
          Date.now() - pending.timestamp < 60000
        ) {
          setRegisteredGroup(chatJid, {
            ...group,
            isMain: true,
          });
          this.pendingCommands.delete(conversationId);
          logger.info(
            { chatJid, name: group.name },
            'Group set as main via command',
          );
          await this.sendMessage(
            chatJid,
            `✅ 此群已设置为主群！\n\n名称：${group.name}\n文件夹：${group.folder}`,
          );
        } else {
          await this.sendMessage(
            chatJid,
            `确认超时或没有待确认的操作。请重新发送 /set-main`,
          );
        }
        return;
      }

      // /unset-main command - remove main group status
      if (content === '/unset-main' || content === '！取消主群') {
        if (!group.isMain) {
          await this.sendMessage(chatJid, `此群不是主群。\n\n当前状态：普通群`);
        } else {
          await this.sendMessage(
            chatJid,
            `⚠️ 即将取消此群的主群状态。\n\n发送 /unset-main-confirm 确认，或 /cancel 取消`,
          );
          this.pendingCommands.set(conversationId, {
            type: 'unset-main',
            timestamp: Date.now(),
          });
        }
        return;
      }

      // /unset-main-confirm command
      if (content === '/unset-main-confirm' || content === '！确认取消主群') {
        const pending = this.pendingCommands.get(conversationId);
        if (
          pending?.type === 'unset-main' &&
          Date.now() - pending.timestamp < 60000
        ) {
          setRegisteredGroup(chatJid, {
            ...group,
            isMain: false,
          });
          this.pendingCommands.delete(conversationId);
          logger.info(
            { chatJid, name: group.name },
            'Group unset as main via command',
          );
          await this.sendMessage(
            chatJid,
            `✅ 已取消主群状态！\n\n名称：${group.name}\n文件夹：${group.folder}`,
          );
        } else {
          await this.sendMessage(
            chatJid,
            `确认超时或没有待确认的操作。请重新发送 /unset-main`,
          );
        }
        return;
      }

      // /cancel command - cancel pending operation
      if (content === '/cancel' || content === '！取消') {
        const pending = this.pendingCommands.get(conversationId);
        if (pending) {
          this.pendingCommands.delete(conversationId);
          await this.sendMessage(chatJid, `已取消操作：${pending.type}`);
        }
        return;
      }
    }

    // Determine message content based on type
    let messageContent = '';
    switch (msgtype as string) {
      case 'text':
        messageContent = text?.content?.trim() || '';
        break;
      case 'image':
        messageContent = '[Image]';
        break;
      case 'file':
        messageContent = '[File]';
        break;
      case 'audio':
        messageContent = '[Audio]';
        break;
      case 'video':
        messageContent = '[Video]';
        break;
      case 'link':
        messageContent = '[Link]';
        break;
      default:
        messageContent = `[${msgtype}]`;
    }

    if (!messageContent) {
      return;
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderStaffId,
      sender_name: senderName,
      content: messageContent,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: senderName }, 'DingTalk message received');
  }

  private getRegisterHelp(): string {
    return `请提供以下信息来注册此群聊：

格式：/register 名称|文件夹|触发器

示例：/register 我的群|my_group|@Andy

说明：
• 名称：群聊显示名称（中文或英文）
• 文件夹：只能用字母、数字、下划线，不超过64字符
• 触发器：如 @Andy 或 @机器人

提示：发送 /chatid 查看当前群聊ID`;
  }

  private async handleRegisterCommand(
    chatJid: string,
    argsContent: string,
  ): Promise<void> {
    // Parse: name|folder|trigger
    const parts = argsContent.split('|').map((s) => s.trim());
    if (parts.length !== 3) {
      await this.sendMessage(chatJid, `格式错误！${this.getRegisterHelp()}`);
      return;
    }

    const [name, folder, trigger] = parts;

    // Validate name
    if (!name || name.length === 0) {
      await this.sendMessage(chatJid, '错误：群聊名称不能为空');
      return;
    }

    // Validate folder
    if (!isValidGroupFolder(folder)) {
      await this.sendMessage(
        chatJid,
        '错误：文件夹名无效。只能使用字母、数字、下划线，1-64字符，不能以特殊字符开头',
      );
      return;
    }

    // Validate trigger
    if (!trigger || trigger.length === 0) {
      await this.sendMessage(chatJid, '错误：触发器不能为空');
      return;
    }

    // Check if folder already exists
    const groupPath = resolveGroupFolderPath(folder);
    if (fs.existsSync(groupPath)) {
      await this.sendMessage(
        chatJid,
        `错误：文件夹 "${folder}" 已存在，请选择其他名称`,
      );
      return;
    }

    // Create group folder
    try {
      fs.mkdirSync(groupPath, { recursive: true });

      // Create CLAUDE.md file
      const ClaudeMdPath = path.join(groupPath, 'CLAUDE.md');
      fs.writeFileSync(
        ClaudeMdPath,
        `# ${name}\n\nThis is a DingTalk group chat folder for "${name}".\n\nGroup: ${name}\nTrigger: ${trigger}\n`,
        'utf-8',
      );
    } catch (err) {
      logger.error({ folder, err }, 'Failed to create group folder');
      await this.sendMessage(chatJid, `错误：创建文件夹失败`);
      return;
    }

    // Register in database
    try {
      setRegisteredGroup(chatJid, {
        name,
        folder,
        trigger,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      });

      logger.info(
        { chatJid, name, folder, trigger },
        'DingTalk group registered via /register command',
      );
      await this.sendMessage(
        chatJid,
        `✅ 注册成功！\n\n名称：${name}\n文件夹：${folder}\n\n现在可以直接发送消息，无需触发器！`,
      );
    } catch (err) {
      logger.error({ chatJid, err }, 'Failed to register group in database');
      await this.sendMessage(chatJid, `错误：数据库注册失败`);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const conversationId = jid.replace(/^dingtalk:/, '');
    const sessionWebhook = this.sessionWebhooks.get(conversationId);

    if (!sessionWebhook) {
      logger.warn({ jid }, 'No sessionWebhook stored for conversation');
      return;
    }

    if (!this.client) {
      logger.warn('DingTalk client not initialized');
      return;
    }

    try {
      const accessToken = await this.client.getAccessToken();

      // DingTalk has message length limits - split if needed
      const MAX_LENGTH = 2000;
      const chunks: string[] = [];

      if (text.length <= MAX_LENGTH) {
        chunks.push(text);
      } else {
        // Split into chunks, trying to break at newlines
        let remaining = text;
        while (remaining.length > 0) {
          const chunkEnd = Math.min(MAX_LENGTH, remaining.length);
          let splitPoint = chunkEnd;

          // Try to find a newline break point
          if (remaining.length > MAX_LENGTH) {
            const lastNewline = remaining.lastIndexOf('\n', MAX_LENGTH);
            if (lastNewline > MAX_LENGTH * 0.5) {
              splitPoint = lastNewline + 1;
            }
          }

          chunks.push(remaining.slice(0, splitPoint).trimEnd());
          remaining = remaining.slice(splitPoint);
        }
      }

      for (const chunk of chunks) {
        const body = {
          msgtype: 'text',
          text: {
            content: chunk,
          },
        };

        await axios({
          url: sessionWebhook,
          method: 'POST',
          responseType: 'json',
          data: body,
          headers: {
            'x-acs-dingtalk-access-token': accessToken,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        });
      }

      logger.info({ jid, length: text.length }, 'DingTalk message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send DingTalk message');
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dingtalk:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
      this.sessionWebhooks.clear();
      logger.info('DingTalk bot disconnected');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // DingTalk doesn't support typing indicators via Stream API
    // This is a no-op for compatibility
  }
}

// Self-registration
registerChannel('dingtalk', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET']);
  const clientId =
    process.env.DINGTALK_CLIENT_ID || envVars.DINGTALK_CLIENT_ID || '';
  const clientSecret =
    process.env.DINGTALK_CLIENT_SECRET || envVars.DINGTALK_CLIENT_SECRET || '';

  if (!clientId || !clientSecret) {
    logger.debug(
      'DingTalk: DINGTALK_CLIENT_ID or DINGTALK_CLIENT_SECRET not set',
    );
    return null;
  }

  return new DingTalkChannel(clientId, clientSecret, opts);
});
