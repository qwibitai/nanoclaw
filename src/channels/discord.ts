import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
  ThreadChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  InboundMessage,
  OnChatMetadata,
  OnInboundMessage,
  PlaceType,
  RegisteredGroup,
} from '../types.js';

/** Discord channel type から PlaceType を解決する */
function resolvePlaceType(channel: Message['channel']): PlaceType {
  if (channel.isThread()) {
    if (channel.type === ChannelType.PrivateThread) return 'private_thread';
    if (channel.parent?.type === ChannelType.GuildForum) {
      return 'forum_post_thread';
    }
    return 'public_thread';
  }
  if (channel.type === ChannelType.DM || channel.type === ChannelType.GroupDM) {
    return 'chat_channel';
  }
  if (channel.type === ChannelType.GuildAnnouncement)
    return 'guild_announcement';
  return 'guild_text';
}

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private allowedBotIds: Set<string>;

  constructor(
    botToken: string,
    allowedBotIds: Set<string>,
    opts: DiscordChannelOpts,
  ) {
    this.botToken = botToken;
    this.allowedBotIds = allowedBotIds;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot && !this.allowedBotIds.has(message.author.id))
        return;
      const isPermittedBot = message.author.bot; // 早期returnを通過した bot は許可済み

      const isThread = message.channel.isThread();
      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;

      // 許可Botは thread_per_message チャンネルのみで処理する
      if (isPermittedBot) {
        const group = this.opts.registeredGroups()[chatJid];
        if (group?.channel_mode !== 'thread_per_message') {
          logger.debug(
            { botId: message.author.id, chatJid },
            'allowed bot message dropped: not thread_per_message channel',
          );
          return;
        }
      }
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // チャット名を決定する
      let chatName: string;
      if (message.guild) {
        if (isThread && message.channel.isThread()) {
          const thread = message.channel as ThreadChannel;
          const parentName = thread.parent?.name || 'unknown';
          chatName = `${message.guild.name} #${parentName} > ${thread.name}`;
        } else {
          const textChannel = message.channel as TextChannel;
          chatName = `${message.guild.name} #${textChannel.name}`;
        }
      } else {
        chatName = senderName;
      }

      // スレッドメッセージの親JIDを解決する
      let parentJid: string | undefined;
      if (isThread && message.channel.isThread() && message.channel.parentId) {
        parentJid = `dc:${message.channel.parentId}`;
      }

      // Discord の @bot メンションを TRIGGER_PATTERN 形式に変換する。
      // Discord のメンションは <@botUserId> のような形式で、
      // TRIGGER_PATTERN（例: ^@Andy\b）には一致しないため、
      // bot が @mentioned されたときにトリガーを先頭に付加する。
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // 視覚的なノイズを避けるため <@botId> メンションを除去する
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // トリガーがまだ先頭にない場合は付加する
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // 添付ファイルを処理 — プレースホルダーを保存してエージェントに送信内容を伝える
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map(
          (att) => {
            const contentType = att.contentType || '';
            if (contentType.startsWith('image/')) {
              return `[Image: ${att.name || 'image'}]`;
            } else if (contentType.startsWith('video/')) {
              return `[Video: ${att.name || 'video'}]`;
            } else if (contentType.startsWith('audio/')) {
              return `[Audio: ${att.name || 'audio'}]`;
            } else {
              return `[File: ${att.name || 'file'}]`;
            }
          },
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // リプライ文脈を処理 — 誰への返信かを含める
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // 参照元メッセージが削除されている可能性がある
        }
      }

      // 発見用にチャットメタデータを保存する
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // 登録済みグループのみ完全なメッセージを配信する。
      // 例外: thread_defaults を持つ親チャンネルのスレッドメッセージは、
      // index.ts がスレッドグループを自動登録できるよう通過させる。
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        if (parentJid) {
          const parentGroup = this.opts.registeredGroups()[parentJid];
          if (parentGroup?.thread_defaults) {
            // 自動登録候補 — メッセージ配信をそのまま続行する
          } else {
            logger.debug(
              { chatJid, chatName },
              'Message from unregistered Discord thread (no parent thread_defaults)',
            );
            return;
          }
        } else {
          logger.debug(
            { chatJid, chatName },
            'Message from unregistered Discord channel',
          );
          return;
        }
      }

      // メッセージを配信 — startMessageLoop() が取得する。
      // InboundMessage は NewMessage を拡張し、Discord 固有のメタデータ
      // (place_type, actor_role, is_thread, parent_jid) を含むが、これらはコールバック専用で永続化されない。
      const inbound: InboundMessage = {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        place_type: resolvePlaceType(message.channel),
        actor_role: 'owner',
        is_thread: isThread,
        parent_jid: parentJid,
      };
      this.opts.onMessage(chatJid, inbound);

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // エラーを適切に処理する
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          {
            username: readyClient.user.tag,
            id: readyClient.user.id,
            allowedBotIds: [...this.allowedBotIds],
          },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings`,
        );
        if (this.allowedBotIds.size > 0) {
          console.log(
            `  Allowed bot IDs (bypass filter): ${[...this.allowedBotIds].join(', ')}`,
          );
        }
        console.log();
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord は1メッセージあたり2000文字の制限がある — 必要に応じて分割する
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  async createThread(
    parentJid: string,
    name: string,
    messageId?: string,
  ): Promise<string | null> {
    if (!this.client) return null;
    try {
      const channelId = parentJid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) return null;
      if (channel.type !== ChannelType.GuildText) {
        logger.warn(
          { parentJid, channelId, channelType: channel.type },
          'Discord channel does not support thread creation',
        );
        return null;
      }
      const baseThreadOpts = {
        name: name.slice(0, 100),
        autoArchiveDuration: 60,
      } as const;
      if (messageId) {
        try {
          const linkedThread = await (channel as TextChannel).threads.create({
            ...baseThreadOpts,
            startMessage: messageId,
          });
          return `dc:${linkedThread.id}`;
        } catch (err) {
          logger.warn(
            { parentJid, messageId, err },
            'Failed to create Discord message-linked thread; falling back',
          );
        }
      }
      const thread = await (channel as TextChannel).threads.create(
        baseThreadOpts,
      );
      return `dc:${thread.id}`;
    } catch (err) {
      logger.error({ parentJid, err }, 'Failed to create Discord thread');
      return null;
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_ALLOWED_BOT_IDS']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  const allowedBotIdsRaw =
    process.env.DISCORD_ALLOWED_BOT_IDS ?? envVars.DISCORD_ALLOWED_BOT_IDS;
  const discordIdPattern = /^\d{17,20}$/;
  const allowedBotIds = new Set(
    allowedBotIdsRaw
      ? allowedBotIdsRaw
          .split(',')
          .map((s) => s.trim())
          .filter((id) => {
            if (!discordIdPattern.test(id)) {
              logger.warn(
                { id },
                'DISCORD_ALLOWED_BOT_IDS: invalid ID skipped',
              );
              return false;
            }
            return true;
          })
      : [],
  );
  return new DiscordChannel(token, allowedBotIds, opts);
});
