import { logger } from '../logger.js';
import type { TelegramChannel } from './telegram.js';

export interface SplitMessageOpts {
  groupJid: string;
  senderUserId: string;
  groupAck: string;
  privateMessage: string;
}

/**
 * Send a split response: short ack in group, full message in user's private DM.
 * 
 * Pattern for group vs private chat responses:
 * - In group: Send brief acknowledgment (e.g., "Got it, check your DMs ✓")
 * - In user's DM: Send full confirmation/details
 * - If user has no private chat: Instruct them to start one
 */
export async function sendSplitMessage(
  channel: TelegramChannel,
  opts: SplitMessageOpts,
): Promise<void> {
  const { groupJid, senderUserId, groupAck, privateMessage } = opts;

  // Send group acknowledgment
  await channel.sendMessage(groupJid, groupAck);

  // Attempt to send private message
  const privateJid = `tg:${senderUserId}`;
  try {
    await channel.sendMessage(privateJid, privateMessage);
    logger.info(
      { groupJid, privateJid },
      'Split message sent (group + private DM)',
    );
  } catch (err) {
    // If private DM fails (user hasn't started chat with bot),
    // send fallback message to group
    const error = err as Error;
    if (error.message?.includes('bot was blocked') || 
        error.message?.includes("can't initiate conversation")) {
      const fallbackMsg = `${groupAck}\n\n⚠️ I couldn't send you a private message. Please start a chat with me first by clicking my name and sending /start`;
      await channel.sendMessage(groupJid, fallbackMsg);
      logger.warn(
        { groupJid, senderUserId },
        'Private DM failed, sent fallback to group',
      );
    } else {
      // Unexpected error — log and notify in group
      logger.error({ groupJid, senderUserId, err }, 'Failed to send private DM');
      await channel.sendMessage(
        groupJid,
        `${groupAck}\n\n⚠️ Error sending private message. Please try again.`,
      );
    }
  }
}

/**
 * Extract sender user ID from a message context.
 * Used to determine who to send private DMs to.
 */
export function extractSenderUserId(message: {
  sender: string;
  chat_jid: string;
}): string | null {
  // For Telegram, sender is already the user ID (stored as string)
  return message.sender || null;
}

/**
 * Check if a JID represents a group chat.
 */
export function isGroupChat(jid: string, chatType?: string): boolean {
  // For Telegram: if we have chatType, use it; otherwise infer from JID
  if (chatType) {
    return chatType === 'group' || chatType === 'supergroup';
  }
  // Telegram group JIDs are typically negative numbers
  const numericId = jid.replace(/^tg:/, '');
  return numericId.startsWith('-');
}
