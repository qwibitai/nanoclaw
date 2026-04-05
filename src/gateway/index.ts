import { GATEWAY_PORT } from '../shared/config.ts';
import { logger } from '../shared/logger.ts';
import { initOneCLI } from '../shared/onecli.ts';
import { logEvent } from './event-log.ts';
import { createGateway } from './server.ts';

// Initialize OneCLI Cloud integration
await initOneCLI();

createGateway(GATEWAY_PORT);

logger.info({ port: GATEWAY_PORT }, 'Nexus gateway listening');
logEvent({
  type: 'system',
  channel: 'system',
  groupId: 'system',
  summary: 'Gateway started',
});
