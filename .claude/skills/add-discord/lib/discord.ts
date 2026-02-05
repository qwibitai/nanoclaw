import { type Client, TextChannel } from 'discord.js';

import { ensureConnected, getDiscordClient } from './discord-client.js';
import type { SkillResult } from './types.js';

export async function getReadyDiscordClient(): Promise<
  { client: Client } | { error: SkillResult }
> {
  const connected = await ensureConnected();
  if (!connected) {
    return {
      error: {
        success: false,
        message: 'Discord client not initialized. Check DISCORD_BOT_TOKEN.',
      },
    };
  }

  const client = getDiscordClient();
  if (!client) {
    return {
      error: { success: false, message: 'Discord client not available' },
    };
  }

  return { client };
}

export async function fetchTextChannel(
  client: Client,
  channelId: string,
): Promise<TextChannel | SkillResult> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !(channel instanceof TextChannel)) {
    return {
      success: false,
      message: `Channel ${channelId} not found or not a text channel`,
    };
  }

  return channel;
}

export function splitMessage(content: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}
