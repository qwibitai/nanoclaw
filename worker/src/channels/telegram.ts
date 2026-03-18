/**
 * ThagomizerClaw — Telegram Channel Webhook Handler
 *
 * Handles Telegram Bot API webhooks.
 * Telegram does not have a request signing mechanism like Slack/Discord —
 * we use a secret token in the webhook URL path instead.
 *
 * Setup:
 *   1. Create a bot via @BotFather, get TELEGRAM_BOT_TOKEN
 *   2. Run: wrangler secret put TELEGRAM_BOT_TOKEN
 *   3. Register webhook: POST https://api.telegram.org/bot<TOKEN>/setWebhook
 *      {"url": "https://your-worker.workers.dev/webhook/telegram/<WEBHOOK_SECRET>"}
 */

import type { Env, NewMessage, ParsedWebhookEvent } from '../types.js';

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
}

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
}

interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export function buildTelegramJid(chatId: number): string {
  return `tg:${chatId}`;
}

export function parseTelegramJid(jid: string): number | null {
  if (!jid.startsWith('tg:')) return null;
  const id = parseInt(jid.slice(3), 10);
  return isNaN(id) ? null : id;
}

export function ownsTelegramJid(jid: string): boolean {
  return jid.startsWith('tg:');
}

/**
 * Verify a Telegram webhook request.
 * Telegram uses a secret token in the URL rather than request signing.
 * The path must match /webhook/telegram/{WEBHOOK_SECRET}
 */
export function verifyTelegramWebhook(
  pathSecret: string,
  env: Env,
): boolean {
  return pathSecret === env.WEBHOOK_SECRET;
}

/**
 * Parse a Telegram webhook update into a normalized message.
 */
export function parseTelegramWebhook(
  update: TelegramUpdate,
): ParsedWebhookEvent | null {
  const msg = update.message ?? update.edited_message ?? update.channel_post;
  if (!msg) return null;

  const text = msg.text ?? msg.caption;
  if (!text) return null;

  const chatId = msg.chat.id;
  const chatJid = buildTelegramJid(chatId);
  const isGroup = msg.chat.type !== 'private';

  const senderId = msg.from?.id ?? chatId;
  const senderName =
    [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') ||
    msg.from?.username ||
    `user_${senderId}`;

  const message: NewMessage = {
    id: `tg_${update.update_id}`,
    chat_jid: chatJid,
    sender: `tg:${senderId}`,
    sender_name: senderName,
    content: text,
    timestamp: new Date(msg.date * 1000).toISOString(),
    is_from_me: false,
    is_bot_message: msg.from?.is_bot ?? false,
    channel: 'telegram',
  };

  return {
    chatJid,
    message,
    channel: 'telegram',
  };
}

/**
 * Send a message via Telegram Bot API.
 */
export async function sendTelegramMessage(
  chatId: number,
  text: string,
  env: Env,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN not configured');
  }

  // Telegram has a 4096 char limit per message — split if needed
  const chunks = splitMessage(text, 4096);

  for (const chunk of chunks) {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
        }),
      },
    );

    if (!response.ok) {
      // Retry without Markdown if formatting fails
      const retry = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk }),
        },
      );
      if (!retry.ok) {
        const err = await retry.text();
        throw new Error(`Telegram send failed: ${err}`);
      }
    }
  }
}

export async function sendTelegramTyping(
  chatId: number,
  env: Env,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    },
  );
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, maxLen);
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline > maxLen * 0.8) {
      chunk = chunk.slice(0, lastNewline);
    }
    chunks.push(chunk.trim());
    remaining = remaining.slice(chunk.length).trim();
  }
  return chunks;
}
