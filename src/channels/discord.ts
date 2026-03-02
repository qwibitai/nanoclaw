import fs from 'fs';
import path from 'path';

import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ALLOWED_USERS, ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import {
  Channel,
  FileAttachment,
  MessageAttachment,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const IMAGE_MAX_SIZE = 5 * 1024 * 1024; // 5MB
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

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
  private startedAt: Date = new Date();

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
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
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      // DM allowlist — if configured, only allow listed user IDs
      if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(message.author.id)) {
        logger.debug(
          { sender: message.author.id, name: message.author.username },
          'Message from non-allowed user, ignoring',
        );
        return;
      }

      // Skip stale messages from before this process started (e.g. after restart)
      if (message.createdAt < this.startedAt) {
        logger.debug(
          {
            sender: message.author.username,
            age: Date.now() - message.createdAt.getTime(),
          },
          'Skipping stale message from before startup',
        );
        return;
      }

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders (with transcription for audio, download for images)
      const group = this.opts.registeredGroups()[chatJid];
      const imageAttachments: MessageAttachment[] = [];
      if (message.attachments.size > 0) {
        const attachmentDescriptions: string[] = [];
        for (const att of message.attachments.values()) {
          const contentType = att.contentType || '';
          if (contentType.startsWith('image/') && SUPPORTED_IMAGE_TYPES.has(contentType)) {
            attachmentDescriptions.push(`[Image: ${att.name || 'image'}]`);
            // Download image for vision (only if registered group and within size limit)
            if (group && att.size <= IMAGE_MAX_SIZE) {
              try {
                const response = await fetch(att.url);
                if (response.ok) {
                  const buffer = Buffer.from(await response.arrayBuffer());
                  const ext = att.name?.split('.').pop() || 'jpg';
                  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
                  const attachDir = path.join(GROUPS_DIR, group.folder, '.attachments');
                  fs.mkdirSync(attachDir, { recursive: true });
                  const savePath = path.join(attachDir, filename);
                  fs.writeFileSync(savePath, buffer);
                  imageAttachments.push({ path: `.attachments/${filename}`, mimeType: contentType });
                }
              } catch (err) {
                logger.warn({ err }, 'Failed to download Discord image for vision');
              }
            }
          } else if (contentType.startsWith('image/')) {
            attachmentDescriptions.push(`[Image: ${att.name || 'image'}]`);
          } else if (contentType.startsWith('video/')) {
            attachmentDescriptions.push(`[Video: ${att.name || 'video'}]`);
          } else if (contentType.startsWith('audio/')) {
            // Attempt transcription for audio attachments
            let desc = `[Audio: ${att.name || 'audio'}]`;
            try {
              const response = await fetch(att.url);
              if (response.ok) {
                const buffer = Buffer.from(await response.arrayBuffer());
                const transcript = await transcribeAudio(buffer, contentType);
                if (transcript) {
                  desc = `[Audio transcript] ${transcript}`;
                }
              }
            } catch (err) {
              logger.warn({ err }, 'Failed to download/transcribe Discord audio');
            }
            attachmentDescriptions.push(desc);
          } else {
            attachmentDescriptions.push(`[File: ${att.name || 'file'}]`);
          }
        }
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
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
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        attachments: imageAttachments.length > 0 ? imageAttachments : undefined,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string, file?: FileAttachment): Promise<void> {
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

      if (file) {
        const attachment = new AttachmentBuilder(file.path, { name: file.name });
        await textChannel.send({
          content: text || undefined,
          files: [attachment],
        });
        logger.info({ jid, file: file.name }, 'Discord message+file sent');
        return;
      }

      // Discord has a 2000 character limit per message — split if needed
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
}
