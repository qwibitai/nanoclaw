import fs from 'fs';
import path from 'path';
import pino from 'pino';

// Central log file — all host + agent events in one JSONL stream.
// Rotation is handled by logrotate (/etc/logrotate.d/nanoclaw).
const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
export const LOG_FILE = path.join(LOG_DIR, 'nanoclaw.jsonl');

// LOG_PRETTY=1  → human-readable (dev/debug sessions)
// Default       → JSONL to file + stdout (journald gets clean JSON, not ANSI)
const isDev = process.env.LOG_PRETTY === '1';

function buildLogger(): pino.Logger {
  const level = process.env.LOG_LEVEL || 'info';

  if (isDev) {
    return pino(
      { level },
      pino.transport({ target: 'pino-pretty', options: { colorize: true } }),
    );
  }

  // Production: JSONL to rotating file + stdout (captured by journald)
  const fileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const streams = pino.multistream([
    { stream: process.stdout, level: 'info' as const },
    { stream: fileStream,     level: 'debug' as const }, // file gets everything incl. debug
  ]);

  return pino({ level }, streams);
}

export const logger = buildLogger();

// Route uncaught errors through pino so they get timestamps and agent context
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
