import {
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  Message,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  Partials,
  SlashCommandBuilder,
  TextChannel,
  User,
  Webhook,
} from 'discord.js';

import {
  ASSISTANT_NAME,
  DISCORD_REACTIONS_INBOUND,
  TRIGGER_PATTERN,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  OnReaction,
  ReactionEvent,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onReaction?: OnReaction;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private webhookCache = new Map<string, Webhook>();

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
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [
        Partials.Channel,
        Partials.Message,
        Partials.User,
        Partials.GuildMember,
        Partials.Reaction,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      logger.info(
        {
          guildId: message.guildId,
          channelId: message.channelId,
          authorId: message.author.id,
          authorBot: message.author.bot,
          contentLen: message.content.length,
        },
        'Discord MessageCreate fired',
      );
      // Ignore bot messages (including own)
      if (message.author.bot) return;

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

      // DMs: auto-prepend trigger — in 1:1 chats every message is addressed to the bot
      if (!message.guild && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Handle attachments — store placeholders so the agent knows something was sent
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
          const repliedText = (repliedTo.content ?? '')
            .replace(/\s+/g, ' ')
            .trim();
          const snippet =
            repliedText.length > 200
              ? `${repliedText.slice(0, 200)}…`
              : repliedText;
          const quoted = snippet ? ` "${snippet}"` : '';
          content = `[Reply to ${replyAuthor}${quoted}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
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
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Reaction handlers — inbound only if DISCORD_REACTIONS_INBOUND !== 'off'.
    const handleReaction = async (
      reaction: MessageReaction | PartialMessageReaction,
      user: User | PartialUser,
      action: 'add' | 'remove',
    ) => {
      if (DISCORD_REACTIONS_INBOUND === 'off') return;
      if (!this.client?.user) return;
      // Ignore bot reactions (including our own) to prevent feedback loops.
      if (user.bot || user.id === this.client.user.id) return;

      try {
        if (reaction.partial) await reaction.fetch();
        if (reaction.message.partial) await reaction.message.fetch();
      } catch (err) {
        logger.debug({ err }, 'Failed to fetch partial reaction');
        return;
      }

      // v1: unicode only. Custom emoji have a non-null id.
      if (reaction.emoji.id !== null) {
        logger.debug(
          { emoji: reaction.emoji.name },
          'Skipping custom emoji reaction (v1 unicode only)',
        );
        return;
      }
      const emoji = reaction.emoji.name;
      if (!emoji) return;

      const msg = reaction.message;
      const chatJid = `dc:${msg.channelId}`;
      if (!this.opts.registeredGroups()[chatJid]) return;

      const onBotMessage = msg.author?.id === this.client.user.id;
      if (DISCORD_REACTIONS_INBOUND === 'own' && !onBotMessage) return;

      try {
        if (!user.partial && !('username' in user && user.username)) {
          await user.fetch();
        }
      } catch {
        /* ignore */
      }

      const userName =
        ('globalName' in user && user.globalName) ||
        ('username' in user && user.username) ||
        'Unknown';
      const timestamp = new Date().toISOString();
      const snippet = (msg.content || '').slice(0, 60);

      const event: ReactionEvent = {
        id: `${msg.id}:${user.id}:${emoji}:${action}:${timestamp}`,
        chat_jid: chatJid,
        message_id: msg.id,
        user_id: user.id,
        user_name: userName as string,
        emoji,
        action,
        timestamp,
        on_bot_message: onBotMessage,
        target_snippet: snippet,
      };

      this.opts.onReaction?.(chatJid, event);
      logger.info(
        { chatJid, action, emoji, user: userName },
        'Discord reaction event',
      );
    };

    this.client.on(Events.MessageReactionAdd, (reaction, user) =>
      handleReaction(reaction, user, 'add'),
    );
    this.client.on(Events.MessageReactionRemove, (reaction, user) =>
      handleReaction(reaction, user, 'remove'),
    );

    // Slash command handler — currently just /health. Translates the
    // interaction into a synthetic "health" message routed through the
    // normal message pipeline; the reply goes back via the regular
    // sendMessage() path to the channel, and we acknowledge the
    // interaction with an ephemeral "running..." so Discord doesn't
    // time out (3s hard limit on interaction responses).
    this.client.on(
      Events.InteractionCreate,
      async (interaction: Interaction) => {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== 'health') return;

        try {
          await interaction.reply({
            content: '🩺 Running health check...',
            ephemeral: true,
          });
        } catch (err) {
          logger.warn({ err }, 'Failed to ack /health interaction');
        }

        const chatJid = `dc:${interaction.channelId}`;
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          try {
            await interaction.followUp({
              content: '⚠️ This channel is not registered with Claudio.',
              ephemeral: true,
            });
          } catch {
            /* ignore */
          }
          return;
        }

        this.opts.onMessage(chatJid, {
          id: `slash-health-${Date.now()}`,
          chat_jid: chatJid,
          sender: interaction.user.id,
          sender_name:
            interaction.user.globalName ||
            interaction.user.username ||
            'Unknown',
          content: `@${ASSISTANT_NAME} health`,
          timestamp: new Date().toISOString(),
          is_from_me: false,
        });
      },
    );

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, async (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );

        // Register global slash commands. Global commands can take up to
        // an hour to propagate to all clients; re-registering the same
        // command set is a no-op, so it's safe to run on every startup.
        try {
          const commands = [
            new SlashCommandBuilder()
              .setName('health')
              .setDescription(
                'Run Claudio health check (containers, tasks, sheets, disk)',
              )
              .toJSON(),
          ];
          await readyClient.application.commands.set(commands);
          logger.info(
            { count: commands.length },
            'Registered Discord slash commands',
          );
        } catch (err) {
          logger.error({ err }, 'Failed to register Discord slash commands');
        }

        // Pre-cache DM channels so MessageCreate fires reliably.
        // discord.js doesn't auto-cache DM channels on connect, so
        // without this, DM events silently fail until the channel
        // is fetched at least once.
        const groups = this.opts.registeredGroups();
        for (const [jid, group] of Object.entries(groups)) {
          if (!group.isDm) continue;
          const channelId = jid.replace('dc:', '');
          try {
            await readyClient.channels.fetch(channelId);
            logger.info({ channelId }, 'Pre-cached DM channel');
          } catch (err) {
            logger.warn(
              { channelId, err: (err as Error).message },
              'Failed to pre-cache DM channel',
            );
          }
        }

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

  async sendMessageWithId(
    jid: string,
    text: string,
  ): Promise<string | undefined> {
    if (!this.client) return undefined;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return undefined;
      const textChannel = channel as TextChannel;
      const MAX_LENGTH = 2000;
      let lastId: string | undefined;
      if (text.length <= MAX_LENGTH) {
        const m = await textChannel.send(text);
        lastId = m.id;
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const m = await textChannel.send(text.slice(i, i + MAX_LENGTH));
          lastId = m.id;
        }
      }
      return lastId;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message with id');
      return undefined;
    }
  }

  async editMessage(
    jid: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.edit(text.slice(0, 2000));
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to edit Discord message');
    }
  }

  async deleteMessage(jid: string, messageId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.delete();
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to delete Discord message');
    }
  }

  async pinMessage(jid: string, messageId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.pin();
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to pin Discord message');
    }
  }

  async unpinMessage(jid: string, messageId: string): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.unpin();
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to unpin Discord message');
    }
  }

  async addReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.client) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      await msg.react(emoji);
      logger.info({ jid, messageId, emoji }, 'Discord reaction added');
    } catch (err) {
      logger.error(
        { jid, messageId, emoji, err },
        'Failed to add Discord reaction',
      );
    }
  }

  async removeReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.client?.user) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return;
      const msg = await (channel as TextChannel).messages.fetch(messageId);
      const r = msg.reactions.resolve(emoji);
      if (r) await r.users.remove(this.client.user.id);
      logger.info({ jid, messageId, emoji }, 'Discord reaction removed');
    } catch (err) {
      logger.error(
        { jid, messageId, emoji, err },
        'Failed to remove Discord reaction',
      );
    }
  }

  async sendWebhookMessage(
    jid: string,
    text: string,
    username: string,
    avatarURL?: string,
  ): Promise<string | undefined> {
    if (!this.client?.user) return undefined;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('fetchWebhooks' in channel)) return undefined;
      const textChannel = channel as TextChannel;

      // Lazily create or reuse a shared webhook per channel
      let webhook = this.webhookCache.get(channelId);
      if (!webhook) {
        const existing = await textChannel.fetchWebhooks();
        webhook = existing.find(
          (w) =>
            w.name === 'NanoClaw Pets' && w.owner?.id === this.client!.user!.id,
        );
        if (!webhook) {
          webhook = await textChannel.createWebhook({
            name: 'NanoClaw Pets',
          });
        }
        this.webhookCache.set(channelId, webhook);
      }

      const msg = await webhook.send({
        content: text,
        username,
        avatarURL,
      });
      logger.info(
        { jid, username, length: text.length },
        'Discord webhook message sent',
      );
      return typeof msg === 'string' ? undefined : msg.id;
    } catch (err) {
      logger.error(
        { jid, username, err },
        'Failed to send Discord webhook message',
      );
      return undefined;
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

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
