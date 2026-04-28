/**
 * Additional Discord bot identities for the PR factory.
 *
 * v1 registered three Discord bots: 'discord' (worker), 'discord-supervisor',
 * and 'discord-tester'. Each has its own bot token and appears as a separate
 * user in Discord, so test results and supervisor feedback post under distinct
 * identities in PR threads.
 *
 * This module registers the supervisor and tester bots as separate channel
 * adapters. They follow the same Chat SDK bridge pattern as the primary
 * 'discord' adapter. If their tokens aren't set, they silently skip
 * (the primary Discord bot handles all traffic).
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../../env.js';
import { createChatSdkBridge } from '../../channels/chat-sdk-bridge.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { log } from '../../log.js';

function registerExtraDiscordBot(
  channelName: string,
  tokenEnvVar: string,
  publicKeyEnvVar: string,
  appIdEnvVar: string,
): void {
  registerChannelAdapter(channelName, {
    factory: () => {
      const env = readEnvFile([tokenEnvVar, publicKeyEnvVar, appIdEnvVar]);
      const token = env[tokenEnvVar];
      const publicKey = env[publicKeyEnvVar];
      if (!token || !publicKey) {
        log.debug(`PR factory: ${tokenEnvVar} or ${publicKeyEnvVar} not set, ${channelName} bot disabled`);
        return null;
      }
      const adapter = createDiscordAdapter({
        botToken: token,
        publicKey,
        applicationId: env[appIdEnvVar],
      });
      return createChatSdkBridge({
        adapter,
        channelName: channelName,
        concurrency: 'concurrent',
        botToken: token,
        supportsThreads: true,
      });
    },
  });
}

registerExtraDiscordBot(
  'discord-supervisor',
  'DISCORD_SUPERVISOR_BOT_TOKEN',
  'DISCORD_SUPERVISOR_PUBLIC_KEY',
  'DISCORD_SUPERVISOR_APPLICATION_ID',
);
registerExtraDiscordBot(
  'discord-tester',
  'DISCORD_TESTER_BOT_TOKEN',
  'DISCORD_TESTER_PUBLIC_KEY',
  'DISCORD_TESTER_APPLICATION_ID',
);
