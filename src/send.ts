import crypto from 'crypto';

import { storeMessage } from './db.js';
import type { Channel } from './types.js';

/**
 * Send a bot message and store it in the DB so it appears in message
 * history. Channels that self-echo (e.g. WhatsApp via Baileys
 * messages.upsert) skip the explicit store to avoid duplicate rows.
 */
export async function sendAndStore(
  channel: Channel,
  chatJid: string,
  text: string,
  assistantName: string,
): Promise<void> {
  await channel.sendMessage(chatJid, text);
  if (!channel.storesSentMessages?.()) {
    storeMessage({
      id: `bot-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      chat_jid: chatJid,
      sender: 'bot',
      sender_name: assistantName,
      content: text,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });
  }
}
