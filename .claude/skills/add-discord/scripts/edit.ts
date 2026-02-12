/**
 * Discord Integration - Edit message
 */

import { fetchTextChannel, getReadyDiscordClient } from '../lib/discord.js';
import { formatDiscordError, type SkillResult } from '../lib/types.js';

export interface EditInput {
  channelId: string;
  messageId: string;
  content: string;
}

export async function editDiscordMessage(
  input: EditInput,
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

    await message.edit(input.content.slice(0, 2000));
    return { success: true, message: `Message ${input.messageId} edited` };
  } catch (err) {
    return formatDiscordError(err, 'Failed to edit message');
  }
}
