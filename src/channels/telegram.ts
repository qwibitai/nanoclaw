import crypto from 'crypto';
import https from 'https';
import { createServer, Server } from 'http';
import { Api, Bot, webhookCallback } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

const pendingRejections = new Map<
  string,
  { decisionId: string; expiresAt: number }
>();

const pendingSpendPrompts = new Map<
  string,
  { merchantName: string; visitEndTime: string; expiresAt: number }
>();

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private webhookUrl: string | null;
  private webhookServer: Server | null = null;
  private webhookSecretToken: string;
  private useWebhook: boolean;

  constructor(
    botToken: string,
    opts: TelegramChannelOpts,
    webhookUrl?: string,
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.webhookUrl = webhookUrl || null;
    this.useWebhook = !!this.webhookUrl;
    // Generate a random secret token for webhook verification
    this.webhookSecretToken = crypto.randomBytes(32).toString('hex');
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    this.setupHandlers();

    if (this.useWebhook) {
      await this.startWebhook();
    } else {
      await this.startPolling();
    }
  }

  private setupHandlers(): void {
    // Command to get chat ID (useful for registration)
    this.bot!.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot!.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to manage pantry items — CEO chat only
    this.bot!.command('pantry', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];

      // Restrict to CEO group only
      if (!group || group.folder !== 'ceo') {
        return;
      }

      const pantryUrl =
        process.env.PANTRY_MANAGER_URL || 'http://localhost:3052';
      const args = ((ctx.match as string) || '').trim();
      const spaceIdx = args.indexOf(' ');
      const subcommand =
        spaceIdx >= 0
          ? args.slice(0, spaceIdx).toLowerCase()
          : args.toLowerCase();
      const rest = spaceIdx >= 0 ? args.slice(spaceIdx + 1).trim() : '';

      try {
        if (subcommand === 'add') {
          if (!rest) {
            await ctx.reply(
              'Usage: /pantry add milk, eggs, oat milk',
            );
            return;
          }

          // Parse comma-separated item names
          const itemNames = rest
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

          // Fetch existing products once to avoid repeated requests
          const productsResp = await fetch(`${pantryUrl}/api/v1/products`);
          if (!productsResp.ok)
            throw new Error(`Products API returned ${productsResp.status}`);
          const products = (await productsResp.json()) as Array<{
            id: number;
            name: string;
          }>;
          const productMap = new Map(
            products.map((p) => [p.name.toLowerCase(), p]),
          );

          const added: string[] = [];

          for (const itemName of itemNames) {
            // Find or create product
            let product = productMap.get(itemName.toLowerCase());

            if (!product) {
              const createResp = await fetch(`${pantryUrl}/api/v1/products`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: itemName }),
              });
              if (!createResp.ok)
                throw new Error(
                  `Create product returned ${createResp.status}`,
                );
              product = (await createResp.json()) as { id: number; name: string };
              productMap.set(itemName.toLowerCase(), product);
            }

            // Create pantry item
            const itemResp = await fetch(`${pantryUrl}/api/v1/pantry-items`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                product_id: product.id,
                user_id: 'jeff',
                quantity: 1,
                purchased_at: new Date().toISOString(),
              }),
            });
            if (!itemResp.ok)
              throw new Error(
                `Create pantry item returned ${itemResp.status}`,
              );
            added.push(itemName);
          }

          await ctx.reply(`Added to pantry: ${added.join(', ')}`);
        } else if (subcommand === 'list') {
          const [itemsResp, productsResp] = await Promise.all([
            fetch(`${pantryUrl}/api/v1/pantry-items`),
            fetch(`${pantryUrl}/api/v1/products`),
          ]);
          if (!itemsResp.ok || !productsResp.ok)
            throw new Error('Pantry API error');

          const items = (await itemsResp.json()) as Array<{
            id: number;
            product_id: number;
            quantity: number;
            purchased_at: string | null;
          }>;
          const products = (await productsResp.json()) as Array<{
            id: number;
            name: string;
          }>;
          const productById = new Map(products.map((p) => [p.id, p.name]));

          const recent = items
            .slice()
            .sort((a, b) => {
              const tA = a.purchased_at
                ? new Date(a.purchased_at).getTime()
                : 0;
              const tB = b.purchased_at
                ? new Date(b.purchased_at).getTime()
                : 0;
              return tB - tA;
            })
            .slice(0, 10);
          if (recent.length === 0) {
            await ctx.reply(
              'No pantry items yet. Use /pantry add to add some.',
            );
            return;
          }

          const lines = recent.map((item) => {
            const name =
              productById.get(item.product_id) || `Product #${item.product_id}`;
            const date = item.purchased_at
              ? new Date(item.purchased_at).toLocaleDateString()
              : 'unknown date';
            return `• ${name} (qty: ${item.quantity}, added: ${date})`;
          });

          await ctx.reply(
            `*Pantry Items* (last ${recent.length}):\n${lines.join('\n')}`,
            { parse_mode: 'Markdown' },
          );
        } else if (subcommand === 'status') {
          const resp = await fetch(`${pantryUrl}/api/v1/nudges/status`);
          if (!resp.ok)
            throw new Error(`Nudges status returned ${resp.status}`);

          const status = (await resp.json()) as {
            total_tracked_products: number;
            nudge_eligible_count: number;
            suppressed_count: number;
            confidence_breakdown: {
              low: number;
              medium: number;
              high: number;
            };
          };

          const msg = [
            `*Pantry Nudge Status*`,
            `• Tracked products: ${status.total_tracked_products}`,
            `• Nudge-eligible: ${status.nudge_eligible_count}`,
            `• Suppressed: ${status.suppressed_count}`,
            `• Confidence: ${status.confidence_breakdown.high} high, ${status.confidence_breakdown.medium} medium, ${status.confidence_breakdown.low} low`,
          ].join('\n');

          await ctx.reply(msg, { parse_mode: 'Markdown' });
        } else {
          await ctx.reply(
            'Usage:\n' +
              '  /pantry add <items> — add items (comma-separated)\n' +
              '  /pantry list — show recent pantry items\n' +
              '  /pantry status — show nudge engine summary',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Pantry command error');
        await ctx.reply('Pantry Manager is offline — try again later');
      }
    });

    this.bot!.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      // Check for pending rejection reason flow
      const chatIdKey = String(ctx.chat?.id);
      const pending = pendingRejections.get(chatIdKey);
      if (pending) {
        pendingRejections.delete(chatIdKey);
        if (pending.expiresAt > Date.now()) {
          const text = ctx.message.text.trim();
          const rationale = text.toLowerCase() === 'skip' ? '' : text;
          try {
            const agencyHqUrl =
              process.env.AGENCY_HQ_URL || 'http://localhost:3040';
            const resp = await fetch(
              `${agencyHqUrl}/api/v1/decisions/${pending.decisionId}`,
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'rejected', rationale }),
              },
            );
            if (!resp.ok) throw new Error(`Agency HQ returned ${resp.status}`);
            const summary = rationale ? ` Reason: ${rationale}` : '';
            await ctx.reply(`✅ Decision rejected.${summary}`);
            logger.info(
              { decisionId: pending.decisionId },
              'Decision rejected with reason',
            );
          } catch (err) {
            logger.error(
              { err, decisionId: pending.decisionId },
              'Failed to submit rejection',
            );
            await ctx.reply(
              '❌ Failed to submit rejection — please try again.',
            );
          }
          return;
        }
        // Expired — fall through to normal handling
      }

      // Check for pending spend prompt reply
      const pendingSpend = pendingSpendPrompts.get(chatIdKey);
      if (pendingSpend) {
        pendingSpendPrompts.delete(chatIdKey);
        if (pendingSpend.expiresAt > Date.now()) {
          const text = ctx.message.text.trim().toLowerCase();
          if (text !== 'skip' && text !== 'nothing' && text !== 'n') {
            const amountMatch = text.replace(/[$,]/g, '').match(/[\d]+(?:\.\d{1,2})?/);
            if (amountMatch) {
              const amount = parseFloat(amountMatch[0]);
              try {
                const pingUrl = process.env.PING_BASE_URL || 'http://localhost:3001';
                const pingKey = process.env.PING_API_KEY || process.env.X_PING_KEY || '';
                const resp = await fetch(`${pingUrl}/api/v1/expenses`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-Ping-Key': pingKey,
                  },
                  body: JSON.stringify({
                    merchant: pendingSpend.merchantName,
                    amount,
                    currency: 'USD',
                    category: 'Grocery',
                    timestamp: pendingSpend.visitEndTime,
                  }),
                });
                if (!resp.ok) throw new Error(`Ping expenses returned ${resp.status}`);
                await ctx.reply(`✅ Logged $${amount.toFixed(2)} at ${pendingSpend.merchantName}`);
                logger.info({ merchant: pendingSpend.merchantName, amount }, 'Grocery spend logged');
              } catch (err) {
                logger.error({ err }, 'Failed to log grocery spend to Ping');
                await ctx.reply('❌ Could not log spend — Ping is offline. Try again later.');
              }
            } else {
              await ctx.reply('Could not parse that amount. Try: 47 or $47.50');
              // Re-add prompt so they can retry
              pendingSpendPrompts.set(chatIdKey, pendingSpend);
            }
          }
          return;
        }
        // Expired — fall through
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
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

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
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
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot!.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot!.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot!.on('message:voice', (ctx) =>
      storeNonText(ctx, '[Voice message]'),
    );
    this.bot!.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot!.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot!.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot!.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot!.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle decision vote callbacks from inline keyboard buttons
    this.bot!.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data || '';
      const match = data.match(/^decision:(approve|reject|defer):(.+)$/);
      if (!match) {
        await ctx.answerCallbackQuery('Unknown action');
        return;
      }

      const [, action, decisionId] = match;

      // Rejection flow: ask for reason before submitting
      if (action === 'reject') {
        await ctx.answerCallbackQuery();
        const chatIdKey = String(ctx.chat?.id);
        pendingRejections.set(chatIdKey, {
          decisionId,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
        await ctx.editMessageReplyMarkup();
        await ctx.reply(
          "Please reply with the reason for rejecting this decision (or type 'skip' to reject without a reason).",
        );
        logger.info({ decisionId }, 'Rejection reason requested');
        return;
      }

      const statusMap: Record<string, string> = {
        approve: 'approved',
        defer: 'proposed',
      };
      const labels: Record<string, string> = {
        approve: '✅ Approved',
        defer: '⏸ Deferred',
      };
      const status = statusMap[action];

      try {
        const agencyHqUrl =
          process.env.AGENCY_HQ_URL || 'http://localhost:3040';
        const resp = await fetch(
          `${agencyHqUrl}/api/v1/decisions/${decisionId}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status }),
          },
        );
        if (!resp.ok) throw new Error(`Agency HQ returned ${resp.status}`);

        await ctx.answerCallbackQuery(`${labels[action]}!`);
        // Remove inline keyboard from the original message
        await ctx.editMessageReplyMarkup();
        await ctx.reply(`${labels[action]} — decision updated.`);
        logger.info({ decisionId, action }, 'Decision vote processed');
      } catch (err) {
        logger.error(
          { err, decisionId, action },
          'Failed to process decision vote',
        );
        await ctx.answerCallbackQuery('Error updating decision — try again');
      }
    });

    // Handle errors gracefully
    this.bot!.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });
  }

  private async startPolling(): Promise<void> {
    // Delete any leftover webhook from a previous webhook-mode run
    await this.bot!.api.deleteWebhook();

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected (polling)',
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

  private async startWebhook(): Promise<void> {
    // Initialize the bot (fetches bot info) without starting polling
    await this.bot!.init();

    const botInfo = this.bot!.botInfo;
    logger.info(
      { username: botInfo.username, id: botInfo.id },
      'Telegram bot initialized (webhook)',
    );

    // Parse webhook URL to determine path and port
    const parsedUrl = new URL(this.webhookUrl!);
    const webhookPath = parsedUrl.pathname || '/telegram';
    const listenPort = parseInt(
      process.env.TELEGRAM_WEBHOOK_PORT || '8443',
      10,
    );

    // Create webhook handler using grammy's http adapter
    const handleUpdate = webhookCallback(this.bot!, 'http', {
      secretToken: this.webhookSecretToken,
    });

    // Create a minimal HTTP server for the webhook
    this.webhookServer = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === webhookPath) {
        await handleUpdate(req, res);
      } else {
        res.writeHead(200);
        res.end('OK');
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.webhookServer!.listen(listenPort, () => {
        logger.info(
          { port: listenPort, path: webhookPath },
          'Telegram webhook server listening',
        );
        resolve();
      });
      this.webhookServer!.on('error', reject);
    });

    // Register the webhook with Telegram
    await this.bot!.api.setWebhook(this.webhookUrl!, {
      secret_token: this.webhookSecretToken,
    });

    logger.info(
      { url: this.webhookUrl },
      'Telegram webhook registered with Telegram API',
    );
    console.log(`\n  Telegram bot: @${botInfo.username} (webhook mode)`);
    console.log(`  Send /chatid to the bot to get a chat's registration ID\n`);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  /**
   * Send a grocery spend prompt to the CEO chat when Ping detects a grocery zone exit.
   * The user's reply is intercepted by the message:text handler and logged to Ping expenses.
   */
  async sendGrocerySpendPrompt(
    ceoChatJid: string,
    merchantName: string,
    visitEndTime: string,
  ): Promise<void> {
    if (!this.bot) return;
    const numericId = ceoChatJid.replace(/^tg:/, '');
    const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
    pendingSpendPrompts.set(numericId, {
      merchantName,
      visitEndTime,
      expiresAt: Date.now() + FOUR_HOURS_MS,
    });
    await sendTelegramMessage(
      this.bot.api,
      numericId,
      `Just left ${merchantName} — how much did you spend? (reply with amount or "skip")`,
    );
    logger.info({ merchantName, ceoChatJid }, 'Grocery spend prompt sent');
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      if (this.useWebhook) {
        // Delete webhook registration so Telegram stops sending updates
        try {
          await this.bot.api.deleteWebhook();
          logger.info('Telegram webhook deleted');
        } catch (err) {
          logger.error({ err }, 'Failed to delete Telegram webhook');
        }
        // Close the webhook HTTP server
        if (this.webhookServer) {
          await new Promise<void>((resolve) => {
            this.webhookServer!.close(() => resolve());
          });
          this.webhookServer = null;
          logger.info('Telegram webhook server closed');
        }
      } else {
        this.bot.stop();
      }
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_WEBHOOK_URL',
    'TELEGRAM_WEBHOOK_PORT',
  ]);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  const webhookUrl =
    process.env.TELEGRAM_WEBHOOK_URL || envVars.TELEGRAM_WEBHOOK_URL || '';
  return new TelegramChannel(token, opts, webhookUrl || undefined);
});
