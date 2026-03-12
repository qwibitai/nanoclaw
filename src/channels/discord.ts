import {
  Client,
  Collection,
  Events,
  GatewayIntentBits,
  Message,
  Snowflake,
  TextChannel,
} from "discord.js";

import { ASSISTANT_NAME, TRIGGER_PATTERN } from "../config.js";
import { readEnvFile } from "../env.js";
import { logger } from "../logger.js";
import { getRestartPlan, restartNanoClawService } from "../service-control.js";
import { registerChannel, ChannelOpts } from "./registry.js";
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  PurgeOptions,
  RegisteredGroup,
} from "../types.js";

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = "discord";

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private adminUserId: string | null;

  constructor(botToken: string, opts: DiscordChannelOpts, adminUserId?: string) {
    this.botToken = botToken;
    this.opts = opts;
    this.adminUserId = adminUserId || null;
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

      // Admin commands — intercepted before normal message processing
      if (this.adminUserId && message.author.id === this.adminUserId) {
        const cmd = message.content.trim().toLowerCase();
        if (cmd.startsWith("!restart")) {
          await this.handleRestart(message);
          return;
        }
        if (cmd.startsWith("!purge")) {
          await this.handlePurge(message);
          return;
        }
      }

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName || message.author.displayName || message.author.username;
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
          content = content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = [...message.attachments.values()].map((att) => {
          const contentType = att.contentType || "";
          if (contentType.startsWith("image/")) {
            return `[Image: ${att.name || "image"}]`;
          } else if (contentType.startsWith("video/")) {
            return `[Video: ${att.name || "video"}]`;
          } else if (contentType.startsWith("audio/")) {
            return `[Audio: ${att.name || "audio"}]`;
          } else {
            return `[File: ${att.name || "file"}]`;
          }
        });
        if (content) {
          content = `${content}\n${attachmentDescriptions.join("\n")}`;
        } else {
          content = attachmentDescriptions.join("\n");
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
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
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(chatJid, timestamp, chatName, "discord", isGroup);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid, chatName }, "Message from unregistered Discord channel");
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

      logger.info({ chatJid, chatName, sender: senderName }, "Discord message stored");
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, "Discord client error");
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          "Discord bot connected",
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(`  Use /chatid command or check channel IDs in Discord settings\n`);
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn("Discord client not initialized");
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, "");
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !("send" in channel)) {
        logger.warn({ jid }, "Discord channel not found or not text-based");
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
      logger.info({ jid, length: text.length }, "Discord message sent");
    } catch (err) {
      logger.error({ jid, err }, "Failed to send Discord message");
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith("dc:");
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info("Discord bot stopped");
    }
  }

  async purgeMessages(jid: string, options?: PurgeOptions): Promise<number> {
    if (!this.client) return 0;

    const channelId = jid.replace(/^dc:/, "");
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !("messages" in channel)) return 0;
    const textChannel = channel as TextChannel;

    let totalDeleted = 0;
    const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    let remaining = options?.count ?? Infinity;

    while (remaining > 0) {
      const fetchLimit = Math.min(remaining === Infinity ? 100 : remaining, 100);
      const messages: Collection<Snowflake, Message> = await textChannel.messages.fetch({
        limit: fetchLimit,
      });
      if (messages.size === 0) break;

      // Filter by since date if provided
      let toDelete = options?.since
        ? messages.filter((m) => m.createdAt >= options.since!)
        : messages;

      if (toDelete.size === 0) break;

      // Split into bulk-deletable (<14 days) and old (>14 days)
      const bulkable = toDelete.filter((m) => m.createdTimestamp > twoWeeksAgo);
      const old = toDelete.filter((m) => m.createdTimestamp <= twoWeeksAgo);

      if (bulkable.size > 0) {
        try {
          const deleted = await textChannel.bulkDelete(bulkable, true);
          totalDeleted += deleted.size;
        } catch (err) {
          logger.error({ jid, err }, "Bulk delete failed");
        }
      }

      // Fall back to individual delete for old messages
      for (const [, msg] of old) {
        try {
          await msg.delete();
          totalDeleted++;
          // Rate limit: 1 delete per 500ms to avoid 429s
          await new Promise((r) => setTimeout(r, 500));
        } catch (err) {
          logger.warn({ jid, messageId: msg.id, err }, "Individual delete failed");
        }
      }

      remaining -= toDelete.size;
      if (messages.size < fetchLimit) break; // No more messages
      if (options?.since && old.size === 0 && bulkable.size === 0) break;
    }

    return totalDeleted;
  }

  private async handleRestart(message: Message): Promise<void> {
    try {
      const channel = message.channel as TextChannel;
      const plan = getRestartPlan();
      if (!plan.command) {
        logger.warn({ reason: plan.reason }, "Restart command unavailable on this host");
        await channel.send(`Restart unavailable: ${plan.reason || "unsupported service manager"}`);
        return;
      }

      await channel.send(`Attempting restart via ${plan.manager}...`);
      logger.info({ admin: message.author.id }, "Admin restart requested");
      const result = await restartNanoClawService(plan);
      if (!result.ok) {
        logger.error({ manager: result.manager, err: result.error }, "Restart command failed");
        await channel.send(
          `Restart failed via ${result.manager}: ${result.error || "unknown error"}`,
        );
      }
    } catch (err) {
      logger.error({ err }, "Failed to handle restart command");
    }
  }

  private async handlePurge(message: Message): Promise<void> {
    const content = message.content.trim();
    const args = content.slice("!purge".length).trim().toLowerCase();
    const jid = `dc:${message.channelId}`;

    let options: PurgeOptions = {};

    if (!args || args === "all") {
      // Purge all messages
      options = {};
    } else if (args.startsWith("since midnight")) {
      const now = new Date();
      options = {
        since: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
      };
    } else {
      const count = parseInt(args, 10);
      if (!isNaN(count) && count > 0) {
        options = { count };
      } else {
        await message.reply("Usage: `!purge`, `!purge all`, `!purge 50`, `!purge since midnight`");
        return;
      }
    }

    logger.info({ admin: message.author.id, jid, options }, "Admin purge requested");

    try {
      const deleted = await this.purgeMessages(jid, options);
      // The confirmation message itself won't be purged since it's sent after
      const textChannel = message.channel as TextChannel;
      await textChannel.send(`Purged ${deleted} messages`);
    } catch (err) {
      logger.error({ jid, err }, "Purge failed");
      await message.reply("Purge failed — check logs.");
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, "");
      const channel = await this.client.channels.fetch(channelId);
      if (channel && "sendTyping" in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, "Failed to send Discord typing indicator");
    }
  }
}

registerChannel("discord", (opts: ChannelOpts) => {
  const envVars = readEnvFile(["DISCORD_BOT_TOKEN", "DISCORD_ADMIN_USER_ID"]);
  const token = process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || "";
  if (!token) {
    logger.warn("Discord: DISCORD_BOT_TOKEN not set");
    return null;
  }
  const adminUserId = process.env.DISCORD_ADMIN_USER_ID || envVars.DISCORD_ADMIN_USER_ID || "";
  return new DiscordChannel(token, opts, adminUserId || undefined);
});
