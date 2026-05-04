import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the SDK so we never hit real Sentry servers.
vi.mock('@sentry/node', () => {
  let initialized = false;
  return {
    init: vi.fn(() => {
      initialized = true;
    }),
    captureException: vi.fn(),
    isInitialized: vi.fn(() => initialized),
    // Reset hook used by tests via vi.mocked() to roll back fake state
    // between cases — wired up below in beforeEach.
    __resetForTests: () => {
      initialized = false;
    },
  };
});

describe('sentry-init', () => {
  let originalDsn: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(async () => {
    originalDsn = process.env.SENTRY_DSN;
    originalNodeEnv = process.env.NODE_ENV;
    vi.resetModules();
    vi.clearAllMocks();
    const sentry = (await import('@sentry/node')) as unknown as { __resetForTests: () => void };
    sentry.__resetForTests();
  });

  afterEach(() => {
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('does not call Sentry.init when SENTRY_DSN is unset', async () => {
    delete process.env.SENTRY_DSN;
    const Sentry = await import('@sentry/node');
    const { initSentryFromEnv } = await import('./sentry-init.js');

    const result = initSentryFromEnv();

    expect(result).toBe(false);
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('calls Sentry.init exactly once with the spec shape when SENTRY_DSN is set', async () => {
    process.env.SENTRY_DSN = 'https://example-public-key@o0.ingest.sentry.io/0';
    process.env.NODE_ENV = 'production';

    const Sentry = await import('@sentry/node');
    await import('./sentry-init.js');

    expect(Sentry.init).toHaveBeenCalledTimes(1);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://example-public-key@o0.ingest.sentry.io/0',
        environment: 'production',
        tracesSampleRate: 0,
        sendDefaultPii: false,
      }),
    );
  });

  it('idempotent: a second initSentryFromEnv call does not re-init', async () => {
    process.env.SENTRY_DSN = 'https://k@host/0';
    const Sentry = await import('@sentry/node');
    const { initSentryFromEnv } = await import('./sentry-init.js');

    expect(Sentry.init).toHaveBeenCalledTimes(1);
    const second = initSentryFromEnv();

    expect(second).toBe(true);
    expect(Sentry.init).toHaveBeenCalledTimes(1);
  });
});
