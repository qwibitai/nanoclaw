/**
 * Linear channel adapter (v2) — uses Chat SDK bridge.
 * Issue comment threads as conversations.
 * Self-registers on import.
 *
 * Linear OAuth apps can't be @-mentioned, so this adapter relies on the
 * bridge's default onNewMessage catch-all to forward every comment.
 */
import { createLinearAdapter } from '@chat-adapter/linear';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('linear', {
  factory: () => {
    const env = readEnvFile([
      'LINEAR_API_KEY',
      'LINEAR_CLIENT_ID',
      'LINEAR_CLIENT_SECRET',
      'LINEAR_WEBHOOK_SECRET',
      'LINEAR_BOT_USERNAME',
      'LINEAR_TEAM_KEY',
    ]);
    if (!env.LINEAR_API_KEY && !env.LINEAR_CLIENT_ID) return null;

    const auth = env.LINEAR_CLIENT_ID
      ? { clientId: env.LINEAR_CLIENT_ID, clientSecret: env.LINEAR_CLIENT_SECRET }
      : { apiKey: env.LINEAR_API_KEY };

    const linearAdapter = createLinearAdapter({
      ...auth,
      webhookSecret: env.LINEAR_WEBHOOK_SECRET,
      userName: env.LINEAR_BOT_USERNAME,
    });

    // Override channelIdFromThreadId to return a team-based channel ID.
    // The upstream adapter returns per-issue UUIDs which creates a new
    // messaging group for every issue. We want one group per team.
    const teamKey = env.LINEAR_TEAM_KEY || 'default';
    linearAdapter.channelIdFromThreadId = () => `linear:${teamKey}`;

    return createChatSdkBridge({ adapter: linearAdapter, concurrency: 'queue', supportsThreads: true });
  },
});
