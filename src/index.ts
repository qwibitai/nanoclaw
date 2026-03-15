import { initApp } from './lifecycle.js';
import {
  initDispatcher,
  recoverPendingMessages,
  startMessageLoop,
} from './message-dispatcher.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';
export { getAvailableGroups, _setRegisteredGroups } from './lifecycle.js';

async function main(): Promise<void> {
  await initApp();
  initDispatcher();
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
