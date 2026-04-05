import { GATEWAY_PORT } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { logEvent } from './event-log.js';
import { createGateway } from './server.js';

const server = createGateway(GATEWAY_PORT);

server.listen(GATEWAY_PORT, () => {
  logger.info({ port: GATEWAY_PORT }, 'Nexus gateway listening');
  logEvent({
    type: 'system',
    channel: 'system',
    groupId: 'system',
    summary: 'Gateway started',
  });
});
