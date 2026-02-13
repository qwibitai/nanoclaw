import { Api, Bot } from "grammy";

import {
  ASSISTANT_NAME,
  TRIGGER_PATTERN,
} from "../config.js";
import { logger } from "../logger.js";
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from "../types.js";

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Parse a Telegram JID into chat ID and optional thread ID.
 * JID format: `tg:CHAT_ID` or `tg:CHAT_ID:THREAD_ID`
 */
export function parseTelegramJid(jid: string): { chatId: string; threadId?: number } {
  const parts = jid.replace(/^tg:/, '').split(':');
  return {
    chatId: parts[0],
    threadId: parts[1] ? parseInt(parts[1], 10) : undefined,
  };
}

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot send (caller handles this)
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    // Rename the bot to match the sender's role, then wait for Telegram to propagate
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned and renamed pool bot');
    } catch (err) {
      logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
    }
  }

  const api = poolApis[idx];
  try {
    const { chatId: numericId, threadId } = parseTelegramJid(chatId);
    const opts = threadId ? { message_thread_id: threadId } : undefined;
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text, opts);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH), opts);
      }
    }
    logger.info({ chatId, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TelegramChannel implements Channel {
  name = "telegram";
  prefixAssistantName = false;

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    this.bot.command("chatid", (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === "private"
          ? ctx.from?.first_name || "Private"
          : (ctx.chat as any).title || "Unknown";

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: "Markdown" },
      );
    });

    this.bot.command("ping", (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.command("createtopic", async (ctx) => {
      // Only works in supergroups with forum/topics enabled
      if (ctx.chat.type !== "supergroup") {
        await ctx.reply("Topics can only be created in supergroups with forum topics enabled.");
        return;
      }

      // Parse topic name from command args
      const args = ctx.message?.text.split(" ").slice(1).join(" ");
      if (!args || args.trim().length === 0) {
        await ctx.reply("Usage: /createtopic <topic name>\nExample: /createtopic LoadX Logistics");
        return;
      }

      const topicName = args.trim();

      try {
        const topic = await ctx.api.createForumTopic(ctx.chat.id, topicName);
        await ctx.reply(
          `Topic created: *${topicName}*\n\nThread ID: \`tg:${ctx.chat.id}:${topic.message_thread_id}\`\n\nYou can now use this topic for organized discussions!`,
          { parse_mode: "Markdown" }
        );
        logger.info(
          { chatId: ctx.chat.id, topicName, threadId: topic.message_thread_id },
          "Forum topic created"
        );
      } catch (err: any) {
        logger.error({ chatId: ctx.chat.id, topicName, err }, "Failed to create forum topic");
        await ctx.reply(`Failed to create topic: ${err.message || "Unknown error"}`);
      }
    });

    this.bot.on("message:text", async (ctx) => {
      if (ctx.message.text.startsWith("/")) return;

      const threadId = ctx.message.message_thread_id;
      const chatJid = threadId
        ? `tg:${ctx.chat.id}:${threadId}`
        : `tg:${ctx.chat.id}`;
      const baseJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        "Unknown";
      const sender = ctx.from?.id.toString() || "";
      const msgId = ctx.message.message_id.toString();

      const chatName =
        ctx.chat.type === "private"
          ? senderName
          : (ctx.chat as any).title || baseJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === "mention") {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Look up registration: try thread-specific JID first, fall back to base
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid] || groups[baseJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          "Message from unregistered Telegram chat",
        );
        return;
      }

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
        "Telegram message stored",
      );
    });

    // Handle non-text messages with placeholders
    const storeNonText = (ctx: any, placeholder: string) => {
      const threadId = ctx.message?.message_thread_id;
      const chatJid = threadId
        ? `tg:${ctx.chat.id}:${threadId}`
        : `tg:${ctx.chat.id}`;
      const baseJid = `tg:${ctx.chat.id}`;

      const groups = this.opts.registeredGroups();
      const group = groups[chatJid] || groups[baseJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || "Unknown";
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : "";

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || "",
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on("message:photo", (ctx) => storeNonText(ctx, "[Photo]"));
    this.bot.on("message:video", (ctx) => storeNonText(ctx, "[Video]"));
    this.bot.on("message:voice", (ctx) => storeNonText(ctx, "[Voice message]"));
    this.bot.on("message:audio", (ctx) => storeNonText(ctx, "[Audio]"));
    this.bot.on("message:document", (ctx) => {
      const name = ctx.message.document?.file_name || "file";
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on("message:sticker", (ctx) => {
      const emoji = ctx.message.sticker?.emoji || "";
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on("message:location", (ctx) => storeNonText(ctx, "[Location]"));
    this.bot.on("message:contact", (ctx) => storeNonText(ctx, "[Contact]"));

    this.bot.catch((err) => {
      logger.error({ err: err.message }, "Telegram bot error");
    });

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            "Telegram bot connected",
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn("Telegram bot not initialized");
      return;
    }

    try {
      const { chatId, threadId } = parseTelegramJid(jid);
      const opts = threadId ? { message_thread_id: threadId } : undefined;

      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(chatId, text, opts);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(chatId, text.slice(i, i + MAX_LENGTH), opts);
        }
      }
      logger.info({ jid, length: text.length }, "Telegram message sent");
    } catch (err) {
      logger.error({ jid, err }, "Failed to send Telegram message");
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith("tg:");
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info("Telegram bot stopped");
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const { chatId, threadId } = parseTelegramJid(jid);
      const opts = threadId ? { message_thread_id: threadId } : undefined;
      await this.bot.api.sendChatAction(chatId, "typing", opts);
    } catch (err) {
      logger.debug({ jid, err }, "Failed to send Telegram typing indicator");
    }
  }
}
