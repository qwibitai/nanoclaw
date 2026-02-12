/**
 * Discord Integration - Reply to message
 */

import { fetchTextChannel, getReadyDiscordClient } from '../lib/discord.js';
import { formatDiscordError, type SkillResult } from '../lib/types.js';

export interface ReplyInput {
  channelId: string;
  messageId: string;
  content: string;
}

export async function sendDiscordReply(
  input: ReplyInput,
): Promise<SkillResult> {
  const ready = await getReadyDiscordClient();
  if ('error' in ready) return ready.error;

  try {
    const channelResult = await fetchTextChannel(ready.client, input.channelId);
    if ('success' in channelResult) return channelResult;
    const channel = channelResult;

    const message = await channel.messages.fetch(input.messageId);
    if (!message) {
      return {
        success: false,
        message: `Message ${input.messageId} not found`,
      };
    }

    await message.reply(input.content.slice(0, 2000));
    return {
      success: true,
      message: `Reply sent to message ${input.messageId}`,
    };
  } catch (err) {
    return formatDiscordError(err, 'Failed to send reply');
  }
}
