/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('slack', {
  factory: () => {
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
    if (!env.SLACK_BOT_TOKEN) return null;
    const slackAdapter = createSlackAdapter({
      botToken: env.SLACK_BOT_TOKEN,
      signingSecret: env.SLACK_SIGNING_SECRET,
    });
    const bridge = createChatSdkBridge({ adapter: slackAdapter, concurrency: 'concurrent', supportsThreads: true });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await slackAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    // Slack encodes top-level posts with an empty thread_ts (see
    // ChannelAdapter.rewriteThreadIdForSession for why this matters). Mint
    // a per-message id by re-encoding with the message ts as thread_ts;
    // in-thread events already carry a real thread_ts so we no-op.
    bridge.rewriteThreadIdForSession = (threadId: string, messageId: string): string => {
      try {
        const decoded = slackAdapter.decodeThreadId(threadId);
        if (decoded.threadTs) return threadId;
        return slackAdapter.encodeThreadId({ channel: decoded.channel, threadTs: messageId });
      } catch {
        return threadId;
      }
    };
    return bridge;
  },
});
