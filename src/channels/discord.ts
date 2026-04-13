import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, buildTriggerPattern } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export interface DiscordBotOptions {
  jidPrefix?: string;
  label?: string;
  triggerName?: string;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private jidPrefix: string;
  private label: string;
  private triggerName: string;
  private triggerPattern: RegExp;

  constructor(
    botToken: string,
    opts: DiscordChannelOpts,
    options?: DiscordBotOptions,
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.jidPrefix = options?.jidPrefix ?? 'dc';
    this.label = options?.label ?? 'discord';
    this.triggerName = options?.triggerName ?? ASSISTANT_NAME;
    this.triggerPattern = buildTriggerPattern(`@${this.triggerName}`);
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

      const channelId = message.channelId;
      const chatJid = `${this.jidPrefix}:${channelId}`;
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

      // Translate Discord @bot mentions into trigger format.
      // Discord mentions look like <@botUserId> — these won't match
      // the trigger pattern (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned. In multi-bot setups, each bot injects
      // its own triggerName so the correct group receives the message.
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
          // Prepend this bot's trigger if not already present
          if (!this.triggerPattern.test(content)) {
            content = `@${this.triggerName} ${content}`;
          }
        }
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

      // Handle reply context — include who the user is replying to.
      // If the user is replying to the bot's own message, treat it as a trigger
      // so the bot responds even in trigger-only channels.
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

          // If replying to this bot, inject this bot's trigger
          if (repliedTo.author.id === this.client?.user?.id) {
            if (!this.triggerPattern.test(content)) {
              content = `@${this.triggerName} ${content}`;
            }
          }
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
          { chatJid, chatName, bot: this.label },
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
        { chatJid, chatName, sender: senderName, bot: this.label },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error(
        { err: err.message, bot: this.label },
        'Discord client error',
      );
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          {
            username: readyClient.user.tag,
            id: readyClient.user.id,
            bot: this.label,
          },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot [${this.label}]: ${readyClient.user.tag}`);
        console.log(
          `  JID prefix: ${this.jidPrefix}: — use /chatid or check Discord channel settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn({ bot: this.label }, 'Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(new RegExp(`^${this.jidPrefix}:`), '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn(
          { jid, bot: this.label },
          'Discord channel not found or not text-based',
        );
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
      logger.info(
        { jid, length: text.length, bot: this.label },
        'Discord message sent',
      );
    } catch (err) {
      logger.error(
        { jid, err, bot: this.label },
        'Failed to send Discord message',
      );
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(`${this.jidPrefix}:`);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info({ bot: this.label }, 'Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(new RegExp(`^${this.jidPrefix}:`), '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug(
        { jid, err, bot: this.label },
        'Failed to send Discord typing indicator',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Multi-bot configuration
// ---------------------------------------------------------------------------
// Multiple Discord bots can be configured via the DISCORD_BOTS env var.
// Each bot gets its own identity, JID prefix, and trigger name so the
// router can distinguish which bot owns a given channel.
//
// Format:  DISCORD_BOTS=name:token:triggerName;name:token:triggerName
// Example: DISCORD_BOTS=engineer:xMT...abc:Engineer;ops:xMT...xyz:Ops
//
// - name:        used for registry key (discord-{name}) and JID prefix (dc-{name}:)
// - token:       Discord bot token (alphanumeric + . - _ only, no colons)
// - triggerName: the trigger injected on @mention/reply (e.g. "Engineer" → @Engineer)
//
// Falls back to single DISCORD_BOT_TOKEN when DISCORD_BOTS is not set.
// All instances keep name='discord' for text-style passthrough.

interface DiscordBotConfig {
  name: string;
  token: string;
  triggerName: string;
}

function parseDiscordBots(): DiscordBotConfig[] {
  const envVars = readEnvFile(['DISCORD_BOTS']);
  const raw = process.env.DISCORD_BOTS || envVars.DISCORD_BOTS || '';
  if (!raw.trim()) return [];

  const bots: DiscordBotConfig[] = [];
  for (const entry of raw.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    // Token may contain dots but not colons, so exactly 3 parts expected.
    if (parts.length < 3) {
      logger.warn(
        { entry: trimmed },
        'DISCORD_BOTS: skipping malformed entry (expected name:token:triggerName)',
      );
      continue;
    }
    const name = parts[0].trim();
    // Token is everything between first and last colon (handles tokens with dots)
    const triggerName = parts[parts.length - 1].trim();
    const token = parts.slice(1, -1).join(':').trim();
    if (!name || !token || !triggerName) {
      logger.warn(
        { entry: trimmed },
        'DISCORD_BOTS: skipping entry with empty field',
      );
      continue;
    }
    bots.push({ name, token, triggerName });
  }
  return bots;
}

// Register bots
const discordBots = parseDiscordBots();

if (discordBots.length > 0) {
  if (process.env.DISCORD_BOT_TOKEN || readEnvFile(['DISCORD_BOT_TOKEN']).DISCORD_BOT_TOKEN) {
    logger.info(
      'DISCORD_BOTS is set — ignoring DISCORD_BOT_TOKEN (multi-bot takes precedence)',
    );
  }
  for (const bot of discordBots) {
    const registryName = `discord-${bot.name}`;
    const jidPrefix = `dc-${bot.name}`;
    registerChannel(registryName, (opts: ChannelOpts) =>
      new DiscordChannel(bot.token, opts, {
        jidPrefix,
        label: bot.name,
        triggerName: bot.triggerName,
      }),
    );
  }
} else {
  // Single-bot fallback: original behavior
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (token) {
    registerChannel('discord', (opts: ChannelOpts) =>
      new DiscordChannel(token, opts),
    );
  } else {
    logger.warn('Discord: no bot tokens set');
  }
}
