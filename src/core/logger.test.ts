import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('logger', () => {
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWriteSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrWriteSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
  });

  it('logger.fatal writes to stderr', async () => {
    // Cover line 72: fatal log level
    const { logger } = await import('./logger.js');
    logger.fatal('test fatal message');

    const output = stderrWriteSpy.mock.calls
      .map((call) => String(call[0]))
      .join('');
    expect(output).toContain('FATAL');
    expect(output).toContain('test fatal message');
  });

  it('logger.fatal with data object writes to stderr', async () => {
    // Cover line 72: fatal with data object
    const { logger } = await import('./logger.js');
    logger.fatal({ key: 'val' }, 'fatal with data');

    const output = stderrWriteSpy.mock.calls
      .map((call) => String(call[0]))
      .join('');
    expect(output).toContain('FATAL');
    expect(output).toContain('fatal with data');
  });

  it('formatErr handles non-Error objects', async () => {
    // Cover line 23: formatErr non-Error branch
    const { logger } = await import('./logger.js');
    logger.error({ err: 'string-error' }, 'non-error object');

    const output = stderrWriteSpy.mock.calls
      .map((call) => String(call[0]))
      .join('');
    expect(output).toContain('non-error object');
    expect(output).toContain('string-error');
  });

  it('formatErr handles Error instances', async () => {
    // Cover line 20-21: formatErr Error branch
    const { logger } = await import('./logger.js');
    logger.error({ err: new Error('real-error') }, 'error instance');

    const output = stderrWriteSpy.mock.calls
      .map((call) => String(call[0]))
      .join('');
    expect(output).toContain('error instance');
    expect(output).toContain('real-error');
  });

  it('log below threshold is suppressed', async () => {
    // Cover line 48: threshold check (debug messages suppressed at info level)
    const { logger } = await import('./logger.js');
    logger.debug('debug message suppressed');

    // Depending on LOG_LEVEL env, debug may be suppressed
    // At default (info level), debug output should not appear
    const stdoutOutput = stdoutWriteSpy.mock.calls
      .map((call) => String(call[0]))
      .join('');
    // If LOG_LEVEL is not set to debug, this will be suppressed
    if (!process.env.LOG_LEVEL || process.env.LOG_LEVEL === 'info') {
      expect(stdoutOutput).not.toContain('debug message suppressed');
    }
  });

  it('uncaughtException handler calls logger.fatal and process.exit', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const { logger } = await import('./logger.js');
    const fatalSpy = vi.spyOn(logger, 'fatal');

    // Find the uncaughtException listener registered by logger.ts
    const listeners = process.listeners('uncaughtException');
    const loggerListener = listeners[listeners.length - 1] as (err: Error) => void;
    loggerListener(new Error('test uncaught'));

    expect(fatalSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Uncaught exception',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    fatalSpy.mockRestore();
  });

  it('unhandledRejection handler calls logger.error', async () => {
    const { logger } = await import('./logger.js');
    const errorSpy = vi.spyOn(logger, 'error');

    const listeners = process.listeners('unhandledRejection');
    const loggerListener = listeners[listeners.length - 1] as (reason: unknown) => void;
    loggerListener(new Error('test rejection'));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Unhandled rejection',
    );
    errorSpy.mockRestore();
  });
});
