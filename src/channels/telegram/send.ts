import type { Api } from 'grammy';

import { logger } from '../../logger.js';

/** Telegram's hard limit on a single sendMessage call. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/**
 * Split `text` into chunks of at most `maxLength` characters. Pure
 * function — no side effects. Splits on character boundary; callers
 * should be fine with that because Telegram's limit is in characters
 * and Markdown formatting spans are on unicode codepoints.
 */
export function chunkMessage(
  text: string,
  maxLength: number = TELEGRAM_MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to
 * plain text if Markdown parsing fails. Claude's output naturally
 * matches Markdown v1 ({@code *bold*}, {@code _italic_}, {@code `code`},
 * {@code ```code blocks```}, {@code [links](url)}).
 */
export async function sendTelegramMessage(
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
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

/**
 * Send a (possibly long) message by chunking it and sending each
 * chunk sequentially. Preserves thread id across chunks.
 */
export async function sendLongTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  for (const chunk of chunkMessage(text)) {
    await sendTelegramMessage(api, chatId, chunk, options);
  }
}
