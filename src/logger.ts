import crypto from 'crypto';
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

/**
 * Generate a short correlation ID for tracing operations across log entries.
 * Uses first 12 hex chars of a UUID for readability while maintaining uniqueness.
 */
export function generateCorrelationId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * Create a pino child logger with a correlationId bound to all log entries.
 * Optionally include additional base context fields.
 */
export function createCorrelationLogger(
  correlationId?: string,
  context?: Record<string, unknown>,
): pino.Logger {
  const id = correlationId ?? generateCorrelationId();
  return logger.child({ correlationId: id, ...context });
}

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
