/**
 * Discord Channel Adapter for Atlas
 *
 * Maps Discord threads and channels to NanoClaw's group system:
 * - Control channel (#control) → isMain: true (admin privileges)
 * - Research/build threads → isMain: false (isolated contexts)
 */

import {
  Client,
  GatewayIntentBits,
  Message,
  ThreadChannel,
  TextChannel,
  ChannelType,
  ActivityType,
} from 'discord.js';
import { Channel, OnInboundMessage, OnChatMetadata } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { logger } from '../logger.js';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CONTROL_CHANNEL_ID = process.env.DISCORD_CONTROL_CHANNEL_ID;

export function createDiscordChannel(opts: ChannelOpts): Channel | null {
  if (!DISCORD_TOKEN) {
    logger.warn('DISCORD_TOKEN not set, skipping Discord channel');
    return null;
  }

  if (!CONTROL_CHANNEL_ID) {
    logger.warn(
      'DISCORD_CONTROL_CHANNEL_ID not set, Atlas needs a control channel',
    );
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  let connected = false;
  const discordJids = new Set<string>();

  /**
   * Check if a channel/thread is the control channel
   */
  function isControlChannel(channelId: string): boolean {
    return channelId === CONTROL_CHANNEL_ID;
  }

  /**
   * Handle incoming messages from Discord
   */
  async function handleMessage(message: Message) {
    // Ignore bot messages
    if (message.author.bot) return;

    const chatJid = message.channelId;
    const isControl = isControlChannel(chatJid);
    const isThread = message.channel.isThread();

    // Track this JID as owned by Discord
    discordJids.add(chatJid);

    // Build NewMessage
    const newMessage = {
      id: message.id,
      chat_jid: chatJid,
      sender: message.author.id,
      sender_name: message.author.username,
      content: message.content,
      timestamp: new Date(message.createdTimestamp).toISOString(),
      is_from_me: false,
      is_bot_message: false,
    };

    // Deliver message to orchestrator
    opts.onMessage(chatJid, newMessage);

    // Deliver metadata
    let channelName = 'Unknown';
    if (message.channel.isThread()) {
      channelName = message.channel.name;
    } else if (message.channel.type === ChannelType.GuildText) {
      channelName = message.channel.name;
    }

    opts.onChatMetadata(
      chatJid,
      newMessage.timestamp,
      channelName,
      'discord',
      isThread || !isControl, // Threads and non-control channels are "groups"
    );

    // Auto-register control channel as main
    if (isControl) {
      const groups = opts.registeredGroups();
      if (!groups[chatJid]) {
        logger.info(
          { channelId: chatJid, channelName },
          'Auto-registering control channel as main',
        );
        // Note: Registration happens via IPC or direct call in orchestrator
        // For now, we just ensure metadata is stored
      }
    }

    // Auto-register threads (research/build contexts)
    if (isThread) {
      const groups = opts.registeredGroups();
      if (!groups[chatJid]) {
        logger.info(
          { threadId: chatJid, threadName: channelName },
          'New thread detected, will auto-register on first message',
        );
      }
    }
  }

  const channel: Channel = {
    name: 'discord',

    async connect() {
      if (connected) return;

      client.on('ready', () => {
        logger.info({ user: client.user?.tag }, 'Discord bot connected');
        connected = true;

        // Set bot status
        client.user?.setPresence({
          activities: [
            {
              name: 'Deep Research & Autonomous Building',
              type: ActivityType.Custom,
            },
          ],
          status: 'online',
        });
      });

      client.on('messageCreate', handleMessage);

      client.on('error', (error) => {
        logger.error({ error }, 'Discord client error');
      });

      await client.login(DISCORD_TOKEN);
    },

    async sendMessage(jid: string, text: string) {
      try {
        const discordChannel = await client.channels.fetch(jid);
        if (!discordChannel) {
          logger.warn({ jid }, 'Discord channel not found');
          return;
        }

        if (discordChannel.isTextBased()) {
          // Split long messages (Discord has 2000 char limit)
          const chunks = splitMessage(text, 2000);
          for (const chunk of chunks) {
            await discordChannel.send(chunk);
          }
        }
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send Discord message');
      }
    },

    isConnected() {
      return connected;
    },

    ownsJid(jid: string) {
      return discordJids.has(jid);
    },

    async disconnect() {
      if (client) {
        await client.destroy();
        connected = false;
      }
    },

    async setTyping(jid: string, isTyping: boolean) {
      if (!isTyping) return; // Discord typing indicators auto-expire

      try {
        const discordChannel = await client.channels.fetch(jid);
        if (discordChannel?.isTextBased()) {
          await discordChannel.sendTyping();
        }
      } catch (err) {
        logger.warn({ jid, err }, 'Failed to set Discord typing indicator');
      }
    },

    async syncGroups(force: boolean) {
      // Discord threads are ephemeral and auto-sync via messageCreate
      // No separate sync needed
      logger.debug('Discord syncGroups called (no-op for Discord)');
    },
  };

  return channel;
}

/**
 * Split long messages for Discord's 2000 character limit
 */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let current = '';

  const lines = text.split('\n');
  for (const line of lines) {
    if (current.length + line.length + 1 > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

// Register the channel factory
registerChannel('discord', createDiscordChannel);
