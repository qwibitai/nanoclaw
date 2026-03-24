import path from 'path';
import pino from 'pino';

const LOG_DIR = path.join(process.cwd(), 'logs');

// Use pino-roll for log rotation when running as a service (no TTY),
// pino-pretty for interactive development.
const isTTY = process.stdout.isTTY;

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isTTY
    ? { target: 'pino-pretty', options: { colorize: true } }
    : {
        target: 'pino-roll',
        options: {
          file: path.join(LOG_DIR, 'nanoclaw.log'),
          size: '10m',
          limit: { count: 5 },
        },
      },
});

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
