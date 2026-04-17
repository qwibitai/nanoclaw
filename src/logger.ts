import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

/** Install process-level error handlers that route through pino.
 *  Only called by the CLI entry point — SDK consumers own their own handlers. */
export function installProcessHandlers(): void {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exitCode = 1;
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled rejection');
  });
}
