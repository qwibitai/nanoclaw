import path from 'path';
import pino from 'pino';

const LOG_DIR = path.join(process.cwd(), 'logs');

// Use pino-roll for log rotation when running as a service (no TTY),
// pino-pretty for interactive development.
const isTTY = process.stdout.isTTY;

// Under vitest, skip the transport entirely and log synchronously to stdout.
// Pino's transports run in a thread-stream worker that is torn down
// asynchronously; any logger.info() call that lands during vitest's
// post-test cleanup throws "the worker has exited" and fails the run
// even though every assertion passed. Synchronous stdout avoids the
// worker lifecycle problem entirely.
export const logger = process.env.VITEST
  ? pino({ level: process.env.LOG_LEVEL || 'silent' })
  : pino({
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

// Route uncaught errors through pino so they get timestamps in stderr.
// Skip under vitest: vitest workers emit benign async-cleanup errors at
// teardown and the fatal-exit handler turns them into failed runs even
// when every test assertion passed.
if (!process.env.VITEST) {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled rejection');
  });
}
