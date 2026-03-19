/**
 * Discord Channel Adapter for Atlas
 *
 * Maps Discord threads and channels to NanoClaw's group system:
 * - Control channel (#control) → isMain: true (admin privileges)
 * - Research/build threads → isMain: false (isolated contexts)
 */

import fs from 'fs';
import path from 'path';
import {
  Client,
  GatewayIntentBits,
  Message,
  ThreadChannel,
  TextChannel,
  ChannelType,
  ActivityType,
  REST,
  Routes,
  Collection,
} from 'discord.js';
import { Channel, OnInboundMessage, OnChatMetadata } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { RESEARCH_SYSTEM_PROMPT } from '../agents/research-prompt.js';
import { BUILD_SYSTEM_PROMPT } from '../agents/build-prompt.js';
import { researchCommand } from '../commands/research.js';
import { buildCommand } from '../commands/build.js';
import { statusCommand } from '../commands/status.js';

const { DISCORD_TOKEN, DISCORD_CONTROL_CHANNEL_ID: CONTROL_CHANNEL_ID } =
  readEnvFile(['DISCORD_TOKEN', 'DISCORD_CONTROL_CHANNEL_ID']);

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
  const activeContainers = new Set<string>();
  const reportsSent = new Set<string>(); // tracks JIDs where verified report was already attached

  // Slash commands collection
  const commands = new Collection<string, any>();
  commands.set(researchCommand.data.name, researchCommand);
  commands.set(buildCommand.data.name, buildCommand);
  commands.set(statusCommand.data.name, statusCommand);

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

      client.on('ready', async () => {
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

        // Register slash commands
        await registerSlashCommands(client);
      });

      client.on('messageCreate', handleMessage);

      client.on('interactionCreate', async (interaction) => {
        // Handle slash commands
        if (interaction.isChatInputCommand()) {
          const command = commands.get(interaction.commandName);
          if (!command) {
            logger.warn(
              { command: interaction.commandName },
              'Unknown command',
            );
            return;
          }

          try {
            if (interaction.commandName === 'status') {
              await command.execute(
                interaction,
                opts.registeredGroups(),
                activeContainers,
              );
            } else {
              // Research and build commands.
              // Wrap onMessage to ensure the thread is registered as a group
              // before its first message is stored — slash commands create
              // threads before any messageCreate fires, so neither the FK on
              // messages.chat_jid nor the registeredGroups lookup would work
              // without this.
              const safeOnMessage = (chatJid: string, msg: any) => {
                const timestamp = msg.timestamp ?? new Date().toISOString();
                const threadName = msg.sender_name ?? chatJid;
                // Claim this JID so ownsJid() returns true for outbound routing
                discordJids.add(chatJid);
                // Upsert the chats row (FK requirement)
                opts.onChatMetadata(
                  chatJid,
                  timestamp,
                  threadName,
                  'discord',
                  true,
                );
                // Auto-register thread as a non-main group if not already known
                if (!opts.registeredGroups()[chatJid]) {
                  const folder = `thread_${chatJid}`;
                  opts.onRegisterGroup(chatJid, {
                    name: threadName,
                    folder,
                    trigger: `@${client.user?.username ?? 'Andy'}`,
                    added_at: timestamp,
                    requiresTrigger: false,
                    isMain: false,
                  });
                  // Write the appropriate CLAUDE.md so the agent knows its role
                  const systemPrompt =
                    interaction.commandName === 'research'
                      ? RESEARCH_SYSTEM_PROMPT
                      : BUILD_SYSTEM_PROMPT;
                  const groupDir = path.join(process.cwd(), 'groups', folder);
                  fs.mkdirSync(groupDir, { recursive: true });
                  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), systemPrompt);
                }
                opts.onMessage(chatJid, msg);
              };
              await command.execute(interaction, safeOnMessage);
            }
          } catch (err) {
            logger.error(
              { err, command: interaction.commandName },
              'Command execution failed',
            );
            const errorMessage = `Failed to execute command: ${err instanceof Error ? err.message : 'Unknown error'}`;

            if (interaction.deferred || interaction.replied) {
              await interaction.followUp({
                content: errorMessage,
                ephemeral: true,
              });
            } else {
              await interaction.reply({
                content: errorMessage,
                ephemeral: true,
              });
            }
          }
        }

        // Handle button interactions (for build workflow)
        if (interaction.isButton()) {
          await handleButtonInteraction(interaction);
        }
      });

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

        if (discordChannel.isTextBased() && 'send' in discordChannel) {
          // Split long messages (Discord has 2000 char limit)
          const chunks = splitMessage(text, 2000);
          for (const chunk of chunks) {
            await (discordChannel as any).send(chunk);
          }

          // Check if a verified research report is ready to attach
          if (!reportsSent.has(jid)) {
            const group = opts.registeredGroups()[jid];
            if (group?.folder) {
              const reportPath = path.join(
                process.cwd(),
                'groups',
                group.folder,
                'research-verified.md',
              );
              if (fs.existsSync(reportPath)) {
                reportsSent.add(jid);
                await (discordChannel as any).send({
                  content: '📄 **Verified research report ready:**',
                  files: [
                    { attachment: reportPath, name: 'research-report.md' },
                  ],
                });
                logger.info({ jid, reportPath }, 'Research report attached');
              }
            }
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
        if (discordChannel?.isTextBased() && 'sendTyping' in discordChannel) {
          await (discordChannel as any).sendTyping();
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

  /**
   * Register slash commands with Discord
   */
  async function registerSlashCommands(client: Client) {
    if (!client.user || !DISCORD_TOKEN) return;

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    const commandData = [
      researchCommand.data.toJSON(),
      buildCommand.data.toJSON(),
      statusCommand.data.toJSON(),
    ];

    try {
      logger.info('Registering slash commands...');

      // Register commands globally (takes up to 1 hour to propagate)
      // For faster testing, use guild-specific registration instead
      const data = await rest.put(Routes.applicationCommands(client.user.id), {
        body: commandData,
      });

      logger.info({ count: commandData.length }, 'Slash commands registered');
    } catch (err) {
      logger.error({ err }, 'Failed to register slash commands');
    }
  }

  /**
   * Handle button interactions for build workflow
   */
  async function handleButtonInteraction(interaction: any) {
    try {
      await interaction.deferUpdate();

      if (interaction.customId === 'show-spec') {
        // Show current CLAUDE.md spec (if it exists)
        await interaction.followUp({
          content:
            '📄 The spec is being maintained in the conversation above. Review the thread to see the current specification.',
          ephemeral: true,
        });
      } else if (interaction.customId === 'start-build') {
        // Trigger autonomous build mode
        await interaction.followUp({
          content:
            '🚀 **Starting autonomous build...**\n\nThe builder agent will now implement the specification. This may take several minutes.',
        });

        // Send build trigger message
        opts.onMessage(interaction.channelId, {
          id: `build-trigger-${Date.now()}`,
          chat_jid: interaction.channelId,
          sender: interaction.user.id,
          sender_name: interaction.user.username,
          content:
            '[BUILD_MODE] Begin autonomous implementation of the CLAUDE.md specification.',
          timestamp: new Date().toISOString(),
          is_from_me: false,
          is_bot_message: false,
        });
      } else if (interaction.customId === 'cancel-build') {
        await interaction.followUp({
          content:
            '❌ Build cancelled. The thread will remain open for reference.',
          ephemeral: true,
        });
      }
    } catch (err) {
      logger.error(
        { err, customId: interaction.customId },
        'Button interaction failed',
      );
    }
  }

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
