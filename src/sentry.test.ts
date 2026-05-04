import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

describe('initSentry', () => {
  let savedDsn: string | undefined;

  beforeEach(() => {
    savedDsn = process.env.SENTRY_DSN;
    vi.clearAllMocks();
    // Force module re-evaluation so initSentry reads env at call time.
    vi.resetModules();
  });

  afterEach(() => {
    if (savedDsn !== undefined) {
      process.env.SENTRY_DSN = savedDsn;
    } else {
      delete process.env.SENTRY_DSN;
    }
  });

  it('calls Sentry.init with the DSN when SENTRY_DSN is set', async () => {
    process.env.SENTRY_DSN = 'https://abc123@o0.ingest.sentry.io/42';
    const { initSentry } = await import('./sentry.js');
    initSentry();
    const { init } = await import('@sentry/node');
    expect(init).toHaveBeenCalledOnce();
    expect(init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://abc123@o0.ingest.sentry.io/42',
        tracesSampleRate: 0,
        sendDefaultPii: false,
      }),
    );
  });

  it('does NOT call Sentry.init when SENTRY_DSN is unset', async () => {
    delete process.env.SENTRY_DSN;
    const { initSentry } = await import('./sentry.js');
    initSentry();
    const { init } = await import('@sentry/node');
    expect(init).not.toHaveBeenCalled();
  });

  it('passes environment:"production" when NODE_ENV is unset', async () => {
    process.env.SENTRY_DSN = 'https://abc123@o0.ingest.sentry.io/42';
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const { initSentry } = await import('./sentry.js');
      initSentry();
      const { init } = await import('@sentry/node');
      expect(init).toHaveBeenCalledWith(expect.objectContaining({ environment: 'production' }));
    } finally {
      if (savedNodeEnv !== undefined) {
        process.env.NODE_ENV = savedNodeEnv;
      } else {
        delete process.env.NODE_ENV;
      }
    }
  });

  it('passes environment from NODE_ENV when set', async () => {
    process.env.SENTRY_DSN = 'https://abc123@o0.ingest.sentry.io/42';
    process.env.NODE_ENV = 'staging';
    const { initSentry } = await import('./sentry.js');
    initSentry();
    const { init } = await import('@sentry/node');
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ environment: 'staging' }));
  });
});
