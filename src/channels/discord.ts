import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  Message,
  MessageReaction,
  PartialMessageReaction,
  User as DiscordUser,
  PartialUser,
  TextChannel,
  DMChannel,
  ChannelType,
} from 'discord.js';

import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import {
  getAllRegisteredGroups,
  storeChatMetadata,
  storeMessageDirect,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';

export interface DiscordChannelOpts {
  token: string;
  onReaction?: (chatJid: string, messageId: string, emoji: string) => void;
}

export class DiscordChannel implements Channel {
  name = 'discord';
  prefixAssistantName = false;

  private client: Client;
  private connected = false;
  private opts: DiscordChannelOpts;

  constructor(opts: DiscordChannelOpts) {
    this.opts = opts;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, (readyClient) => {
        this.connected = true;
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        resolve();
      });

      this.client.on(Events.MessageCreate, (message) => {
        this.handleMessage(message).catch((err) =>
          logger.error({ err }, 'Error handling Discord message'),
        );
      });

      this.client.on(Events.MessageReactionAdd, (reaction, user) => {
        this.handleReaction(reaction, user).catch((err) =>
          logger.error({ err }, 'Error handling Discord reaction'),
        );
      });

      this.client.on(Events.Error, (err) => {
        logger.error({ err }, 'Discord client error');
      });

      this.client.login(this.opts.token).catch(reject);
    });
  }

  async sendMessage(jid: string, text: string): Promise<string | void> {
    const channelId = jidToChannelId(jid);
    if (!channelId) {
      logger.warn({ jid }, 'Cannot resolve Discord channel ID from JID');
      return;
    }

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) {
        logger.warn({ jid, channelId }, 'Discord channel not found or not sendable');
        return;
      }

      const chunks = splitMessage(text, 2000);
      let lastMessageId: string | undefined;
      for (const chunk of chunks) {
        const sent = await (channel as TextChannel | DMChannel).send(chunk);
        lastMessageId = sent.id;
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
      return lastMessageId;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.client.destroy();
    logger.info('Discord bot disconnected');
  }

  /**
   * Resolve the Discord guild ID for a channel.
   * Used to backfill guildId for registered groups on startup.
   */
  async resolveGuildId(channelId: string): Promise<string | undefined> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'guildId' in channel) {
        return (channel as TextChannel).guildId || undefined;
      }
    } catch (err) {
      logger.debug({ channelId, err }, 'Failed to resolve guild ID');
    }
    return undefined;
  }

  /**
   * Resolve the guild name for a given guild ID.
   */
  async resolveGuildName(guildId: string): Promise<string | undefined> {
    try {
      const guild = await this.client.guilds.fetch(guildId);
      return guild?.name;
    } catch (err) {
      logger.debug({ guildId, err }, 'Failed to resolve guild name');
    }
    return undefined;
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return; // Discord typing auto-expires
    const channelId = jidToChannelId(jid);
    if (!channelId) return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel | DMChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore own messages
    if (message.author.id === this.client.user?.id) return;

    let content = message.content;

    // Translate @bot mention into trigger format
    const botId = this.client.user?.id;
    if (botId && content.includes(`<@${botId}>`)) {
      content = content.replace(new RegExp(`<@${botId}>`, 'g'), '').trim();
      if (!TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Allow bot messages through only if they contain our trigger (agent-to-agent comms).
    // This prevents infinite loops — bots must explicitly @mention us.
    if (message.author.bot && !TRIGGER_PATTERN.test(content)) return;

    const isDM = message.channel.type === ChannelType.DM;
    const chatJid = isDM
      ? `dc:dm:${message.author.id}`
      : `dc:${message.channelId}`;

    const timestamp = message.createdAt.toISOString();
    const senderName =
      message.member?.displayName || message.author.displayName || message.author.username;
    const sender = message.author.id;
    const msgId = message.id;

    // DMs always trigger — prepend trigger if not present
    if (isDM && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    // Determine chat name
    const chatName = isDM
      ? senderName
      : (message.channel as TextChannel).name || chatJid;

    // Store chat metadata for discovery (include guild ID for server-level context)
    storeChatMetadata(chatJid, timestamp, chatName, message.guildId || undefined);

    // Check if this chat is registered
    const registeredGroups = getAllRegisteredGroups();
    const group = registeredGroups[chatJid];

    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Discord chat',
      );
      return;
    }

    // Handle attachments (after group check so we know the folder for image downloads)
    if (message.attachments.size > 0) {
      const parts: string[] = [];
      for (const [, a] of message.attachments) {
        if (a.contentType?.startsWith('image/')) {
          try {
            const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
            fs.mkdirSync(mediaDir, { recursive: true });
            const filename = `${msgId}-${a.name || 'image.png'}`;
            const resp = await fetch(a.url);
            fs.writeFileSync(path.join(mediaDir, filename), Buffer.from(await resp.arrayBuffer()));
            parts.push(`[attachment:image file=${filename}]`);
          } catch (err) {
            logger.error({ err, url: a.url }, 'Failed to download Discord image');
            parts.push('[Image]');
          }
        } else if (a.contentType?.startsWith('video/')) {
          parts.push('[Video]');
        } else if (a.contentType?.startsWith('audio/')) {
          parts.push('[Audio]');
        } else {
          parts.push(`[File: ${a.name || 'attachment'}]`);
        }
      }
      const suffix = parts.join(' ');
      content = content ? `${content} ${suffix}` : suffix;
    }

    if (!content) return;

    // Clean up media files older than 24 hours
    this.cleanupOldMedia(group.folder);

    // Store message — startMessageLoop() will pick it up
    storeMessageDirect({
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Discord message stored',
    );
  }
  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: DiscordUser | PartialUser,
  ): Promise<void> {
    // Ignore reactions from the bot itself
    if (user.id === this.client.user?.id) return;

    // Fetch partial reaction/message if needed
    if (reaction.partial) {
      try {
        reaction = await reaction.fetch();
      } catch (err) {
        logger.debug({ err }, 'Failed to fetch partial reaction');
        return;
      }
    }
    if (reaction.message.partial) {
      try {
        await reaction.message.fetch();
      } catch (err) {
        logger.debug({ err }, 'Failed to fetch partial message for reaction');
        return;
      }
    }

    // Only handle reactions on bot messages
    if (reaction.message.author?.id !== this.client.user?.id) return;

    const isDM = reaction.message.channel.type === ChannelType.DM;
    const chatJid = isDM
      ? `dc:dm:${user.id}`
      : `dc:${reaction.message.channelId}`;
    const emoji = reaction.emoji.name || '';

    this.opts.onReaction?.(chatJid, reaction.message.id, emoji);
  }

  private cleanupOldMedia(folder: string): void {
    try {
      const mediaDir = path.join(GROUPS_DIR, folder, 'media');
      if (!fs.existsSync(mediaDir)) return;
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      for (const file of fs.readdirSync(mediaDir)) {
        const filePath = path.join(mediaDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
        }
      }
    } catch {
      // Non-critical — ignore cleanup errors
    }
  }
}

/** Convert a dc: JID to a Discord channel/user ID */
function jidToChannelId(jid: string): string | null {
  if (jid.startsWith('dc:dm:')) return jid.slice(6);
  if (jid.startsWith('dc:')) return jid.slice(3);
  return null;
}

/**
 * Split a message into chunks respecting Discord's 2000-char limit.
 * Prefers splitting at newlines, then spaces, then hard-splits.
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(' ', maxLength);
    if (splitIdx <= 0) splitIdx = maxLength;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
