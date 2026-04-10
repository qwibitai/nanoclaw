import { STORE_PORT, STORE_DIR } from '../shared/config.ts';
import { logger } from '../shared/logger.ts';
import { FilesystemBackend } from './backend.ts';
import { createStore } from './server.ts';

const backend = new FilesystemBackend(STORE_DIR);

// Purge soft-deleted sessions older than 30 days
backend.purgeDeletedSessions(30).then((count) => {
  if (count > 0) logger.info({ count }, 'Purged old deleted sessions');
});

createStore(STORE_PORT, backend);

logger.info({ port: STORE_PORT, dir: STORE_DIR }, 'Nexus store listening');
