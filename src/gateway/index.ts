import { GATEWAY_PORT } from '../shared/config.ts';
import { logger } from '../shared/logger.ts';
import { initOneCLI } from '../shared/onecli.ts';
import { registerChannel } from './channels.ts';
import { initDiscord } from './discord.ts';
import { logEvent } from './event-log.ts';
import { createGateway } from './server.ts';

// Initialize OneCLI Cloud integration
await initOneCLI();

// Register built-in web-chat channel (always available)
registerChannel({
  id: 'web-chat',
  type: 'web-chat',
  connected: true,
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
