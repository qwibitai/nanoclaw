/**
 * Discord Integration - Send message
 */

import {
  fetchTextChannel,
  getReadyDiscordClient,
  splitMessage,
} from '../lib/discord.js';
import { formatDiscordError, type SkillResult } from '../lib/types.js';

export interface SendInput {
  channelId: string;
  content: string;
}

export async function sendDiscordMessage(
  input: SendInput,
): Promise<SkillResult> {
  const ready = await getReadyDiscordClient();
  if ('error' in ready) return ready.error;

  try {
    const channelResult = await fetchTextChannel(ready.client, input.channelId);
    if ('success' in channelResult) return channelResult;
    const channel = channelResult;

    if (input.content.length <= 2000) {
      await channel.send(input.content);
    } else {
      const chunks = splitMessage(input.content, 2000);
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    }

    return {
      success: true,
      message: `Message sent to channel ${input.channelId}`,
    };
  } catch (err) {
    return formatDiscordError(err, 'Failed to send message');
  }
}
