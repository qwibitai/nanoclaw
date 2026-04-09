import path from 'path';
import pino from 'pino';

const LOG_DIR = path.join(process.cwd(), 'logs');

// True when running under vitest. Vitest sets this env var on every worker
// automatically. We carve out two behaviours under it:
//
//   1. Skip pino's transport (pino-pretty / pino-roll). Transports run in a
//      thread-stream worker that vitest tears down asynchronously during
//      post-test cleanup. Any logger.* call that lands after the worker is
//      gone throws "the worker has exited" and fails the run even though
//      every assertion passed. Synchronous stdout avoids the race entirely.
//
//   2. Skip the uncaughtException / unhandledRejection fatal handlers. Vitest
//      emits benign async-cleanup errors at teardown and our fatal-exit
//      handler turns them into failed runs. Vitest has its own default
//      reporter for uncaught errors, so a real bug is still surfaced.
//
// See Sigma devtask #66 / nanoclaw PR #17. Do not remove either carve-out
// without reproducing under vitest with transports enabled — the flake
// manifests as "394/394 assertions passed, worker exited unexpectedly",
// which is the hardest class of CI failure to re-diagnose from scratch.
const IS_VITEST = Boolean(process.env.VITEST);

function createLogger(): pino.Logger {
  if (IS_VITEST) {
    // Default to 'warn' under vitest: passing tests stay quiet (pino drops
    // info/debug), but a failing test still surfaces warnings and errors
    // emitted by production code on the way to failure. Override with
    // LOG_LEVEL=debug when you need full trace output.
    return pino({ level: process.env.LOG_LEVEL || 'warn' });
  }

  // Production / dev: pino-roll for rotated files under a service, pino-pretty
  // for interactive TTY sessions.
  const isTTY = process.stdout.isTTY;
  return pino({
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
}

export const logger = createLogger();

// Route uncaught errors through pino so they get timestamps in stderr.
// Gated off under vitest — see IS_VITEST comment above.
if (!IS_VITEST) {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled rejection');
  });
}
