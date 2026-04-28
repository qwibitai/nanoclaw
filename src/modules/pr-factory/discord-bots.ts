/**
 * Additional Discord bot identities for the PR factory.
 *
 * Registers the supervisor and tester bots as separate channel adapters
 * under the real 'discord' channel type, distinguished by bot_id.
 * If their tokens aren't set, they silently skip.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../../env.js';
import { botIdFromToken } from '../../utils/discord-bot-id.js';
import { createChatSdkBridge } from '../../channels/chat-sdk-bridge.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { log } from '../../log.js';

const botIds: Record<string, string> = {};

export function getBotId(role: 'worker' | 'supervisor' | 'tester'): string | undefined {
  return botIds[role];
}

function registerExtraDiscordBot(
  role: string,
  tokenEnvVar: string,
  publicKeyEnvVar: string,
  appIdEnvVar: string,
): void {
  registerChannelAdapter(`discord-${role}`, {
    factory: () => {
      const env = readEnvFile([tokenEnvVar, publicKeyEnvVar, appIdEnvVar]);
      const token = env[tokenEnvVar];
      const publicKey = env[publicKeyEnvVar];
      if (!token || !publicKey) {
        log.debug(`PR factory: ${tokenEnvVar} or ${publicKeyEnvVar} not set, ${role} bot disabled`);
        return null;
      }
      const id = botIdFromToken(token);
      botIds[role] = id;
      const adapter = createDiscordAdapter({
        botToken: token,
        publicKey,
        applicationId: env[appIdEnvVar],
      });
      return createChatSdkBridge({
        adapter,
        botId: id,
        concurrency: 'concurrent',
        botToken: token,
        supportsThreads: true,
      });
    },
  });
}

// Also extract and export the worker bot ID at startup
const workerEnv = readEnvFile(['DISCORD_BOT_TOKEN']);
if (workerEnv.DISCORD_BOT_TOKEN) {
  botIds['worker'] = botIdFromToken(workerEnv.DISCORD_BOT_TOKEN);
}

registerExtraDiscordBot(
  'supervisor',
  'DISCORD_SUPERVISOR_BOT_TOKEN',
  'DISCORD_SUPERVISOR_PUBLIC_KEY',
  'DISCORD_SUPERVISOR_APPLICATION_ID',
);

// Dynamic import so it registers after supervisor (static imports are hoisted).
await import('../../channels/discord.js');

registerExtraDiscordBot(
  'tester',
  'DISCORD_TESTER_BOT_TOKEN',
  'DISCORD_TESTER_PUBLIC_KEY',
  'DISCORD_TESTER_APPLICATION_ID',
);
