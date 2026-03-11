import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

/**
 * Log a security-relevant event with a consistent `audit: true` tag.
 * Filterable via: grep '"audit":true' or pino query.
 */
export function audit(event: string, data: Record<string, unknown> = {}): void {
  logger.info({ audit: true, event, ...data }, `[AUDIT] ${event}`);
}

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

// Track unhandled rejections — exit after repeated failures to avoid corrupt state
let unhandledRejectionCount = 0;
const REJECTION_EXIT_THRESHOLD = 5;
const REJECTION_WINDOW_MS = 60_000;
let rejectionWindowStart = Date.now();

process.on('unhandledRejection', (reason) => {
  const now = Date.now();
  if (now - rejectionWindowStart > REJECTION_WINDOW_MS) {
    unhandledRejectionCount = 0;
    rejectionWindowStart = now;
  }
  unhandledRejectionCount++;

  logger.error(
    { err: reason, stack: reason instanceof Error ? reason.stack : undefined, count: unhandledRejectionCount },
    'Unhandled rejection — this may indicate a missing await or uncaught promise error',
  );

  if (unhandledRejectionCount >= REJECTION_EXIT_THRESHOLD) {
    logger.fatal(
      { count: unhandledRejectionCount },
      `${REJECTION_EXIT_THRESHOLD} unhandled rejections in ${REJECTION_WINDOW_MS / 1000}s — exiting to prevent corrupt state`,
    );
    process.exit(1);
  }
});
