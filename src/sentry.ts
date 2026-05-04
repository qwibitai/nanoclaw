import * as Sentry from '@sentry/node';

export { Sentry };

/**
 * Initialize Sentry if SENTRY_DSN is set. No-op in local dev / CI.
 * Called once at process startup (src/index.ts) before any other imports.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'production',
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
}
