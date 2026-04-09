import { GATEWAY_PORT, STORE_URL } from '../shared/config.ts';
import { logger } from '../shared/logger.ts';
import { initOneCLI } from '../shared/onecli.ts';
import { setStoreUrl, checkStore } from '../shared/store-client.ts';
import { registerChannel } from './channels.ts';
import { initDiscord } from './discord.ts';
import { logEvent } from './event-log.ts';
import * as queue from './queue.ts';
import { createGateway } from './server.ts';

// Configure store client
setStoreUrl(STORE_URL);
const storeOk = await checkStore();
if (storeOk) {
  logger.info({ url: STORE_URL }, 'Store connected');
} else {
  logger.warn({ url: STORE_URL }, 'Store not reachable — sessions will not persist');
}

// Initialize OneCLI Cloud integration
await initOneCLI();

// Register built-in web-chat channel (always available)
registerChannel({
  id: 'web-chat',
  type: 'web-chat',
  connected: true,
});

// Log agent completion events with correct session ID
queue.onComplete((item, result) => {
  const eventType =
    result.status === 'success' ? 'agent_complete' : 'agent_error';
  const summary =
    result.status === 'success'
      ? (result.result?.slice(0, 80) ?? '(empty response)') +
        ((result.result?.length ?? 0) > 80 ? '...' : '')
      : `Error: ${result.error ?? 'unknown'}`;

  logEvent({
    type: eventType,
    channel: item.channel,
    groupId: item.sessionId,
    summary,
  });
});

// Initialize Discord (activates if DISCORD_BOT_TOKEN is set)
await initDiscord();

createGateway(GATEWAY_PORT);

logger.info({ port: GATEWAY_PORT }, 'Nexus gateway listening');
logEvent({
  type: 'system',
  channel: 'system',
  groupId: 'system',
  summary: 'Gateway started',
});
