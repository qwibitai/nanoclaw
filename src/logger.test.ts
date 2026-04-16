import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('logger', () => {
  const origLogLevel = process.env.LOG_LEVEL;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = origLogLevel;
    }
    vi.resetModules();
  });

  async function importFresh() {
    vi.resetModules();
    return (await import('./logger.js')).logger;
  }

  it('writes info messages to stdout', async () => {
    process.env.LOG_LEVEL = 'info';
    const logger = await importFresh();
    logger.info('hello');
    expect(stdoutSpy).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    const text = stdoutSpy.mock.calls[0][0] as string;
    expect(text).toContain('INFO');
    expect(text).toContain('hello');
  });

  it('writes warn and error messages to stderr', async () => {
    process.env.LOG_LEVEL = 'debug';
    const logger = await importFresh();
    logger.warn('heads up');
    logger.error('bad');
    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });

  it('respects the LOG_LEVEL threshold', async () => {
    process.env.LOG_LEVEL = 'warn';
    const logger = await importFresh();
    logger.debug('quiet');
    logger.info('quiet');
    logger.warn('noisy');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to "info" for unknown LOG_LEVEL values', async () => {
    process.env.LOG_LEVEL = 'not-a-level';
    const logger = await importFresh();
    logger.info('hi');
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it('formats structured data fields and serializes Error instances', async () => {
    process.env.LOG_LEVEL = 'info';
    const logger = await importFresh();
    const err = new Error('boom');
    logger.info({ jid: 'g@g.us', err, nested: { a: 1 } }, 'details');
    const text = stdoutSpy.mock.calls[0][0] as string;
    expect(text).toContain('jid');
    expect(text).toContain('g@g.us');
    expect(text).toContain('"message": "boom"');
    expect(text).toContain('nested');
  });

  it('serializes non-Error err values using JSON', async () => {
    process.env.LOG_LEVEL = 'info';
    const logger = await importFresh();
    logger.info({ err: 'stringy' }, 'oops');
    const text = stdoutSpy.mock.calls[0][0] as string;
    // Non-Error goes through JSON.stringify — quoted string
    expect(text).toContain('"stringy"');
  });

  it('includes a timestamp and pid in each output line', async () => {
    process.env.LOG_LEVEL = 'info';
    const logger = await importFresh();
    logger.info('ping');
    const text = stdoutSpy.mock.calls[0][0] as string;
    expect(text).toMatch(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/);
    expect(text).toContain(`(${process.pid})`);
  });
});
