import fs from 'fs';
import path from 'path';

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
  ThreadChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import {
  getAllGroupsForJid,
  getRegisteredAgentTypesForJid,
  getRegisteredGroup,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { getAgentType, isHostAgentType } from '../runtimes/index.js';
import { isError } from '../error-utils.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.xml',
  '.html',
  '.htm',
  '.yaml',
  '.yml',
  '.toml',
  '.log',
  '.ts',
  '.js',
  '.py',
  '.sh',
  '.css',
  '.env',
  '.ini',
  '.cfg',
]);
const MAX_INLINE_BYTES = 32 * 1024;

function isTextFile(filename: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

export type ApprovalCallback = (
  action: string,
  userId: string,
  messageId: string,
) => void;

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onApproval?: ApprovalCallback;
}

type DiscordGroupScope = 'all' | 'main-only' | 'non-main-only';

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  /** The agent type this bot handles: 'claude-code' | 'gemini' | 'copilot' | 'codex' */
  readonly agentType: string;
  /** Maps parent channelId → threadId for routing replies into threads */
  private activeThreads = new Map<string, string>();
  private scope: DiscordGroupScope;

  constructor(
    botToken: string,
    opts: DiscordChannelOpts,
    agentType = 'claude-code',
    scope: DiscordGroupScope = 'all',
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.agentType = agentType;
    this.scope = scope;
    if (agentType !== 'claude-code') this.name = `discord-${agentType}`;
  }

  private getRegisteredGroupForChannel(
    chatJid: string,
  ): RegisteredGroup | undefined {
    if (this.scope === 'main-only') {
      return getAllGroupsForJid(chatJid).find((group) => group.isMain === true);
    }
    return getRegisteredGroup(chatJid, this.agentType);
  }

  private matchesScope(group: RegisteredGroup): boolean {
    if (this.scope === 'main-only') return group.isMain === true;
    if (this.scope === 'non-main-only') return group.isMain !== true;
    return true;
  }

  private isMainChannelRestrictedToAdminBot(chatJid: string): boolean {
    const groups = getAllGroupsForJid(chatJid);
    if (!groups.some((group) => group.isMain === true)) return false;
    return this.scope !== 'main-only';
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

      // Thread support: if message is in a thread, resolve to parent channel
      // so it matches the registered group, but track the thread for replies
      let channelId = message.channelId;
      if (message.channel.isThread()) {
        const thread = message.channel as ThreadChannel;
        const parentId = thread.parentId;
        if (parentId) {
          this.activeThreads.set(parentId, channelId);
          channelId = parentId;
        }
      }

      const chatJid = `dc:${channelId}`;
      if (this.isMainChannelRestrictedToAdminBot(chatJid)) {
        logger.debug(
          { chatJid, agentType: this.agentType, scope: this.scope },
          'Ignoring Discord message in main admin channel for non-admin bot',
        );
        return;
      }
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

      const registeredGroup = this.getRegisteredGroupForChannel(chatJid);
      if (!registeredGroup) {
        logger.debug(
          { chatJid, chatName, agentType: this.agentType },
          'Message from channel not registered for this Discord bot',
        );
        return;
      }
      if (!this.matchesScope(registeredGroup)) {
        logger.debug(
          { chatJid, agentType: this.agentType, scope: this.scope },
          'Message from channel outside Discord bot scope',
        );
        return;
      }

      // Translate Discord @bot mentions into the registered trigger for this agent.
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
          const trigger = registeredGroup.trigger || `@${ASSISTANT_NAME}`;
          const triggerPattern = new RegExp(
            `^${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
            'i',
          );
          if (!triggerPattern.test(content) && !TRIGGER_PATTERN.test(content)) {
            content = `${trigger} ${content}`.trim();
          }
        }
      }

      // In dedicated single-agent rooms, plain messages should behave like direct prompts.
      const requiresTrigger = registeredGroup.requiresTrigger !== false;
      const isSingleAgentRoom =
        getRegisteredAgentTypesForJid(chatJid).length === 1;
      if (requiresTrigger && isSingleAgentRoom) {
        const trigger = registeredGroup.trigger || `@${ASSISTANT_NAME}`;
        const triggerPattern = new RegExp(
          `^${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
          'i',
        );
        if (!triggerPattern.test(content) && !TRIGGER_PATTERN.test(content)) {
          content = `${trigger} ${content}`.trim();
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
        } catch (err) {
          if (!isError(err)) throw err;
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Download attachments and build path references for the agent
      if (message.attachments.size > 0) {
        const groupDir = resolveGroupFolderPath(registeredGroup.folder);
        const attachDir = path.join(groupDir, 'attachments');
        fs.mkdirSync(attachDir, { recursive: true });

        // Host runners (copilot/gemini/codex) use absolute paths; claude-code uses container paths
        const isHostAgent = isHostAgentType(getAgentType(registeredGroup));

        const attachmentLines: string[] = [];
        for (const att of message.attachments.values()) {
          const contentType = att.contentType || '';
          const filename = att.name || `attachment_${att.id}`;
          const destPath = path.join(attachDir, filename);
          const agentPath = isHostAgent
            ? destPath
            : `/workspace/group/attachments/${filename}`;

          try {
            if (contentType.startsWith('text/') || isTextFile(filename)) {
              const resp = await fetch(att.url);
              const text = await resp.text();
              fs.writeFileSync(destPath, text);
              if (text.length <= MAX_INLINE_BYTES) {
                attachmentLines.push(
                  `[File: ${filename}]\n\`\`\`\n${text}\n\`\`\``,
                );
                continue;
              }
              attachmentLines.push(`[File: ${agentPath}]`);
            } else {
              await downloadFile(att.url, destPath);
              if (contentType.startsWith('image/')) {
                attachmentLines.push(`[Image: ${agentPath}]`);
              } else if (contentType === 'application/pdf') {
                attachmentLines.push(`[PDF: ${agentPath}]`);
              } else {
                attachmentLines.push(`[File: ${agentPath}]`);
              }
            }
          } catch (err) {
            if (!isError(err)) throw err;
            logger.warn({ filename, err }, 'Failed to download attachment');
            attachmentLines.push(`[File: ${filename} (download failed)]`);
          }
        }

        if (attachmentLines.length > 0) {
          content = content
            ? `${content}\n${attachmentLines.join('\n')}`
            : attachmentLines.join('\n');
        }
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

    // Handle button interactions (approval workflow)
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;

      const [action, refId] = interaction.customId.split(':');
      if (!action || !refId) return;

      logger.info(
        { action, refId, user: interaction.user.tag },
        'Discord button interaction',
      );

      if (this.opts.onApproval) {
        this.opts.onApproval(action, interaction.user.id, refId);
      }

      await interaction.update({
        content: `${interaction.message.content}\n\n**${action === 'approve' ? 'Approved' : 'Rejected'}** by ${interaction.user.displayName}`,
        components: [], // Remove buttons after click
      });
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

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    if (this.isMainChannelRestrictedToAdminBot(jid)) {
      logger.warn(
        { jid, agentType: this.agentType, scope: this.scope },
        'Blocked outbound Discord message to main admin channel for non-admin bot',
      );
      return;
    }
    const group = this.getRegisteredGroupForChannel(jid);
    if (group && !this.matchesScope(group)) {
      logger.warn(
        { jid, agentType: this.agentType, scope: this.scope },
        'Blocked outbound Discord message outside bot scope',
      );
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');

      // Thread support: if a thread is active for this channel, reply there
      const threadId = this.activeThreads.get(channelId);
      const targetId = threadId ?? channelId;
      const channel = await this.client.channels.fetch(targetId);

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
      logger.info(
        { jid, threadId: threadId ?? null, length: text.length },
        'Discord message sent',
      );
    } catch (err) {
      if (!isError(err)) throw err;
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  /** Send a message with Approve/Reject buttons for agent operation approval */
  async sendApprovalRequest(
    jid: string,
    text: string,
    refId: string,
  ): Promise<void> {
    if (!this.client) return;

    try {
      const channelId = jid.replace(/^dc:/, '');
      const threadId = this.activeThreads.get(channelId);
      const channel = await this.client.channels.fetch(threadId ?? channelId);

      if (!channel || !('send' in channel)) return;

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`approve:${refId}`)
          .setLabel('Approve')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`reject:${refId}`)
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger),
      );

      await (channel as TextChannel).send({
        content: text,
        components: [row],
      });

      logger.info({ jid, refId }, 'Discord approval request sent');
    } catch (err) {
      if (!isError(err)) throw err;
      logger.error({ jid, err }, 'Failed to send Discord approval request');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    if (!jid.startsWith('dc:')) return false;
    const group = this.getRegisteredGroupForChannel(jid);
    return !!group && this.matchesScope(group);
  }

  handlesAgentType(agentType: string): boolean {
    return this.agentType === agentType;
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
      if (!isError(err)) throw err;
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const env = readEnvFile(['DISCORD_CLAUDE_BOT_TOKEN']);
  const token =
    process.env.DISCORD_CLAUDE_BOT_TOKEN || env.DISCORD_CLAUDE_BOT_TOKEN;
  if (!token) return null;
  return new DiscordChannel(token, opts, 'claude-code', 'non-main-only');
});

registerChannel('discord-admin', (opts: ChannelOpts) => {
  const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_ADMIN_AGENT_TYPE']);
  const token = process.env.DISCORD_BOT_TOKEN || env.DISCORD_BOT_TOKEN;
  if (!token) return null;
  const rawAdminAgentType =
    process.env.DISCORD_ADMIN_AGENT_TYPE || env.DISCORD_ADMIN_AGENT_TYPE;
  const adminAgentType =
    rawAdminAgentType === 'codex' ||
    rawAdminAgentType === 'gemini' ||
    rawAdminAgentType === 'copilot' ||
    rawAdminAgentType === 'claude-code'
      ? rawAdminAgentType
      : 'claude-code';
  return new DiscordChannel(token, opts, adminAgentType, 'main-only');
});

registerChannel('discord-gemini', (opts: ChannelOpts) => {
  const token =
    process.env.DISCORD_GEMINI_BOT_TOKEN ||
    readEnvFile(['DISCORD_GEMINI_BOT_TOKEN']).DISCORD_GEMINI_BOT_TOKEN;
  if (!token) return null;
  return new DiscordChannel(token, opts, 'gemini');
});

registerChannel('discord-copilot', (opts: ChannelOpts) => {
  const token =
    process.env.DISCORD_COPILOT_BOT_TOKEN ||
    readEnvFile(['DISCORD_COPILOT_BOT_TOKEN']).DISCORD_COPILOT_BOT_TOKEN;
  if (!token) return null;
  return new DiscordChannel(token, opts, 'copilot');
});

registerChannel('discord-codex', (opts: ChannelOpts) => {
  const token =
    process.env.DISCORD_CODEX_BOT_TOKEN ||
    readEnvFile(['DISCORD_CODEX_BOT_TOKEN']).DISCORD_CODEX_BOT_TOKEN;
  if (!token) return null;
  return new DiscordChannel(token, opts, 'codex');
});
