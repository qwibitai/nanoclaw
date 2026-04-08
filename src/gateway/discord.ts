/**
 * Discord bot channel for Nexus gateway.
 *
 * Connects to Discord via discord.js, listens for messages,
 * enqueues them as WorkItems, and sends agent responses back.
 *
 * Requires DISCORD_BOT_TOKEN in environment (via OneCLI or Fly secrets).
 * If token is not set, Discord is disabled gracefully.
 */

import { logger } from '../shared/logger.ts';
import { DISCORD_BOT_TOKEN } from '../shared/config.ts';
import { registerChannel } from './channels.ts';
import { getOrCreateSession } from './sessions.ts';
import * as queue from './queue.ts';
import { logEvent } from './event-log.ts';
import type { WorkItem, WorkResult } from '../shared/types.ts';

// deno-lint-ignore no-explicit-any
let client: any = null;

interface DiscordStatus {
  connected: boolean;
  serverName?: string;
  channelCount?: number;
  botUser?: string;
}

let status: DiscordStatus = { connected: false };

export async function initDiscord(): Promise<void> {
  if (!DISCORD_BOT_TOKEN) {
    logger.info('Discord disabled — no DISCORD_BOT_TOKEN set');
    registerChannel({
      id: 'discord',
      type: 'discord',
      connected: false,
    });
    return;
  }

  try {
    const { Client, GatewayIntentBits, Events } = await import('discord.js');

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    client.on(Events.MessageCreate, (message: {
      author: { bot: boolean; username: string };
      content: string;
      channelId: string;
      channel: { send: (text: string) => Promise<void>; sendTyping: () => Promise<void> };
      guild?: { name: string };
    }) => {
      if (message.author.bot) return;

      const channelId = message.channelId;
      const session = getOrCreateSession('discord', channelId);

      // Show typing while processing
      message.channel.sendTyping().catch(() => {});

      const item = queue.enqueue(
        session.id,
        'discord',
        channelId,
        message.content,
        session.agentSessionId,
      );

      logEvent({
        type: 'message_in',
        channel: 'discord',
        groupId: session.id,
        summary: `${message.author.username}: ${message.content.slice(0, 60)}`,
      });

      logger.info(
        { id: item.id, session: session.id, author: message.author.username },
        'Discord message queued',
      );
    });

    // Register completion callback — send Discord replies
    queue.onComplete(async (item: WorkItem, result: WorkResult) => {
      if (item.channel !== 'discord' || !client) return;

      try {
        const channel = await client.channels.fetch(item.channelId);
        if (!channel?.send) return;

        const text = result.result || '(no response)';

        // Split at 2000 chars (Discord limit)
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += 2000) {
          chunks.push(text.slice(i, i + 2000));
        }

        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      } catch (err) {
        logger.error({ err, channelId: item.channelId }, 'Failed to send Discord reply');
      }
    });

    // Wait for ClientReady or error, with timeout
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Discord connection timed out after 15s'));
      }, 15000);

      client.once(Events.ClientReady, () => {
        clearTimeout(timeout);
        const guilds = client.guilds.cache;
        const firstGuild = guilds.first();

        status = {
          connected: true,
          serverName: firstGuild?.name,
          channelCount: firstGuild?.channels.cache.size,
          botUser: client.user?.tag,
        };

        registerChannel({
          id: 'discord',
          type: 'discord',
          connected: true,
          metadata: {
            serverName: status.serverName ?? '',
            botUser: status.botUser ?? '',
          },
        });

        logger.info(
          { server: status.serverName, bot: status.botUser },
          'Discord connected',
        );
        resolve();
      });

      client.once(Events.Error, (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });

      client.login(DISCORD_BOT_TOKEN).catch((err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  } catch (err) {
    logger.error({ err }, 'Discord initialization failed');
    registerChannel({
      id: 'discord',
      type: 'discord',
      connected: false,
    });
  }
}

export function getDiscordStatus(): DiscordStatus {
  return status;
}

export function getInviteUrl(): string | null {
  if (!client?.user) return null;
  const clientId = client.user.id;
  // Permissions: Send Messages (2048) + Read Message History (65536) + View Channels (1024) = 68608
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=68608&scope=bot`;
}
