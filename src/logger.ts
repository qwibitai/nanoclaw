import pino from 'pino';

import { versionTag } from './build-info.js';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { version: versionTag },
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
