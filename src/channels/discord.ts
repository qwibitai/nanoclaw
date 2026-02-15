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
  ThreadAutoArchiveDuration,
  type ThreadChannel,
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
import { Channel, RegisteredGroup } from '../types.js';

export interface DiscordChannelOpts {
  token: string;
  onReaction?: (chatJid: string, messageId: string, emoji: string, userName: string) => void;
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
        GatewayIntentBits.GuildMembers, // Required for guild.members.fetch() in @AllAgents feature
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

  async createThread(jid: string, messageId: string, name: string): Promise<ThreadChannel | null> {
    const channelId = jidToChannelId(jid);
    if (!channelId) return null;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return null;

      const message = await (channel as TextChannel).messages.fetch(messageId);
      const thread = await message.startThread({
        name: name.slice(0, 100),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
      });
      return thread;
    } catch (err) {
      logger.warn({ jid, messageId, err }, 'Failed to create Discord thread');
      return null;
    }
  }

  async sendToThread(thread: ThreadChannel, text: string): Promise<void> {
    try {
      const chunks = splitMessage(text, 2000);
      for (const chunk of chunks) {
        await thread.send(chunk);
      }
    } catch (err) {
      logger.warn({ threadId: thread.id, err }, 'Failed to send to Discord thread');
    }
  }

  async addReaction(jid: string, messageId: string, emoji: string): Promise<void> {
    const channelId = jidToChannelId(jid);
    if (!channelId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);
      await message.react(emoji);
    } catch (err) {
      logger.warn({ jid, messageId, emoji, err }, 'Failed to add Discord reaction');
    }
  }

  async removeReaction(jid: string, messageId: string, emoji: string): Promise<void> {
    const channelId = jidToChannelId(jid);
    if (!channelId) return;
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);
      const botReaction = message.reactions.cache.find(r => r.emoji.name === emoji);
      if (botReaction) await botReaction.users.remove(this.client.user!.id);
    } catch (err) {
      logger.warn({ jid, messageId, emoji, err }, 'Failed to remove Discord reaction');
    }
  }

  /**
   * Check if message should auto-respond based on group config
   */
  private shouldAutoRespond(content: string, group: RegisteredGroup): boolean {
    // Check for question ending with '?'
    if (group.autoRespondToQuestions && content.trim().endsWith('?')) {
      return true;
    }

    // Check for keywords with word-boundary matching (case-insensitive)
    // Uses \b to avoid matching substrings (e.g., "help" won't match "helper")
    if (group.autoRespondKeywords) {
      return group.autoRespondKeywords.some((keyword: string) => {
        // Escape special regex characters in the keyword
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
        return pattern.test(content);
      });
    }

    return false;
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore own messages
    if (message.author.id === this.client.user?.id) return;

    let content = message.content;

    // **NEW**: @AllAgents shortcut - pings all Discord agent bots in the server
    if (content.includes('@AllAgents') || content.includes('@allagents')) {
      const registeredGroups = getAllRegisteredGroups();
      const agentMentions: string[] = [];

      // Find all Discord agents (dc: or dc:dm: JIDs)
      for (const [jid, group] of Object.entries(registeredGroups)) {
        if (jid.startsWith('dc:') && !jid.includes(':dm:')) {
          // Get channel and fetch bot members
          try {
            const channelId = jidToChannelId(jid);
            if (channelId && message.guildId) {
              const guild = message.client.guilds.cache.get(message.guildId);
              const members = await guild?.members.fetch();
              const botMembers = members?.filter(m => m.user.bot && m.user.id !== this.client.user?.id);

              botMembers?.forEach(bot => {
                agentMentions.push(`<@${bot.user.id}>`);
              });
            }
          } catch (err) {
            logger.warn({ jid, err }, 'Failed to fetch bot members for @AllAgents');
          }
        }
      }

      // Replace @AllAgents with actual mentions
      const uniqueMentions = [...new Set(agentMentions)];
      const mentionString = uniqueMentions.join(' ');
      content = content.replace(/@AllAgents|@allagents/gi, mentionString);

      logger.info({ agentCount: uniqueMentions.length }, 'Expanded @AllAgents shortcut');
    }

    // Translate @bot mention into trigger format
    // FIX: Determine agent name from the channel's registered group, not global ASSISTANT_NAME
    const botId = this.client.user?.id;
    if (botId && content.includes(`<@${botId}>`)) {
      content = content.replace(new RegExp(`<@${botId}>`, 'g'), '').trim();
      if (!TRIGGER_PATTERN.test(content)) {
        // Get agent name from the group's trigger (e.g., "@OmarOmni" → "OmarOmni")
        const isDM = message.channel.type === ChannelType.DM;
        const chatJid = isDM
          ? `dc:dm:${message.author.id}`
          : `dc:${message.channelId}`;
        const registeredGroups = getAllRegisteredGroups();
        const group = registeredGroups[chatJid];
        const agentName = group?.trigger?.replace(/^@/, '') || ASSISTANT_NAME;
        content = `@${agentName} ${content}`;
      }
    }

    // Resolve all remaining <@USER_ID> mentions to display names so the agent
    // knows who is being referenced. Uses server nickname > global display name > username.
    if (message.mentions.members?.size) {
      for (const [id, member] of message.mentions.members) {
        if (id === botId) continue; // Already handled above
        const name = member.displayName || member.user.displayName || member.user.username;
        content = content.replace(new RegExp(`<@!?${id}>`, 'g'), `@${name}`);
      }
    } else if (message.mentions.users?.size) {
      // Fallback for DMs or when member data isn't available
      for (const [id, user] of message.mentions.users) {
        if (id === botId) continue;
        const name = user.displayName || user.username;
        content = content.replace(new RegExp(`<@!?${id}>`, 'g'), `@${name}`);
      }
    }
    // Resolve <@&ROLE_ID> role mentions and <#CHANNEL_ID> channel mentions
    if (message.mentions.roles?.size) {
      for (const [id, role] of message.mentions.roles) {
        content = content.replace(new RegExp(`<@&${id}>`, 'g'), `@${role.name}`);
      }
    }
    if (message.mentions.channels?.size) {
      for (const [id, ch] of message.mentions.channels) {
        const name = 'name' in ch ? (ch as TextChannel).name : id;
        content = content.replace(new RegExp(`<#${id}>`, 'g'), `#${name}`);
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

    // Smart auto-respond: check if we should respond without explicit mention
    const hasTrigger = TRIGGER_PATTERN.test(content);
    if (!hasTrigger && !isDM) {
      // Not a DM and no trigger — check if auto-respond is enabled
      if (this.shouldAutoRespond(content, group)) {
        logger.debug(
          { chatJid, autoRespondToQuestions: group.autoRespondToQuestions, autoRespondKeywords: group.autoRespondKeywords },
          'Auto-responding based on group config',
        );
        // Prepend trigger so message gets processed
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

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

    const userName = user.displayName || user.username || 'Someone';
    this.opts.onReaction?.(chatJid, reaction.message.id, emoji, userName);
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
