/**
 * Sentry init for the Baget channel host. Imported FIRST in
 * src/index.ts so the SDK's global error handlers are installed before
 * any other module load can throw. `sendDefaultPii=false` because we
 * MUST NOT ship founder IPs / chat content to Sentry — error stacks
 * are enough for triage.
 */
import * as Sentry from '@sentry/node';

export function initSentryFromEnv(): boolean {
  if (Sentry.isInitialized()) return true;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
  return true;
}

initSentryFromEnv();
