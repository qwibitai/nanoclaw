/**
 * iMessage channel adapter (v2) — uses Chat SDK bridge.
 * Supports local mode (macOS Full Disk Access) and remote mode (Photon API).
 * Self-registers on import.
 */
import { createiMessageAdapter } from 'chat-adapter-imessage';

import { readEnvFile } from '../env.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

registerChannelAdapter('imessage', {
  factory: () => {
    const env = readEnvFile(['IMESSAGE_ENABLED', 'IMESSAGE_LOCAL', 'IMESSAGE_SERVER_URL', 'IMESSAGE_API_KEY']);
    const isLocal = env.IMESSAGE_LOCAL !== 'false';
    if (isLocal && !env.IMESSAGE_ENABLED) return null;
    if (!isLocal && !env.IMESSAGE_SERVER_URL) return null;
    const rawAdapter = createiMessageAdapter({
      local: isLocal,
      serverUrl: env.IMESSAGE_SERVER_URL,
      apiKey: env.IMESSAGE_API_KEY,
    });
    // Polyfill channelIdFromThreadId (community adapter doesn't implement it)
    const imessageAdapter = Object.assign(rawAdapter, {
      channelIdFromThreadId: (threadId: string) => threadId,
    });
    return createChatSdkBridge({ adapter: imessageAdapter, concurrency: 'concurrent', supportsThreads: false });
  },
});
