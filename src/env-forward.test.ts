import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
}));

// We mock fs.readFileSync to control forward-list content per test.
const mockReadFileSync = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: (filePath: string, encoding: string) =>
        mockReadFileSync(filePath, encoding),
    },
  };
});

import { getForwardedEnv } from './env-forward.js';
import { logger } from './logger.js';

const FORWARD_LIST_PATH = '/tmp/nanoclaw-test-data/env/forward-list';

function enoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Restore any process.env keys we set during tests
  delete process.env['TEST_VAR_A'];
  delete process.env['TEST_VAR_B'];
  delete process.env['TEST_VAR_C'];
});

describe('getForwardedEnv', () => {
  it('returns empty record when forward-list file is absent', () => {
    mockReadFileSync.mockImplementation(() => {
      throw enoent();
    });

    const result = getForwardedEnv();

    expect(result).toEqual({});
  });

  it('returns empty record when forward-list file is empty', () => {
    mockReadFileSync.mockReturnValue('');

    const result = getForwardedEnv();

    expect(result).toEqual({});
  });

  it('resolves a var that is present in process.env', () => {
    process.env['TEST_VAR_A'] = 'value-a';
    mockReadFileSync.mockReturnValue('TEST_VAR_A\n');

    const result = getForwardedEnv();

    expect(result).toEqual({ TEST_VAR_A: 'value-a' });
  });

  it('resolves multiple vars present in process.env', () => {
    process.env['TEST_VAR_A'] = 'alpha';
    process.env['TEST_VAR_B'] = 'beta';
    mockReadFileSync.mockReturnValue('TEST_VAR_A\nTEST_VAR_B\n');

    const result = getForwardedEnv();

    expect(result).toEqual({ TEST_VAR_A: 'alpha', TEST_VAR_B: 'beta' });
  });

  it('emits a warning and omits var absent from process.env, does not throw', () => {
    delete process.env['TEST_VAR_C'];
    mockReadFileSync.mockReturnValue('TEST_VAR_C\n');

    const result = getForwardedEnv();

    expect(result).toEqual({});
    expect(logger.warn).toHaveBeenCalledWith(
      { name: 'TEST_VAR_C' },
      expect.stringContaining('not found in process.env'),
    );
  });

  it('skips blank lines and lines starting with #', () => {
    process.env['TEST_VAR_A'] = 'present';
    mockReadFileSync.mockReturnValue(
      '# this is a comment\n\nTEST_VAR_A\n\n# another comment\n',
    );

    const result = getForwardedEnv();

    expect(result).toEqual({ TEST_VAR_A: 'present' });
  });

  it('reads the forward-list from the correct path', () => {
    mockReadFileSync.mockReturnValue('');

    getForwardedEnv();

    expect(mockReadFileSync).toHaveBeenCalledWith(FORWARD_LIST_PATH, 'utf-8');
  });

  it('propagates unexpected read errors', () => {
    const unexpectedError = new Error('Permission denied');
    mockReadFileSync.mockImplementation(() => {
      throw unexpectedError;
    });

    expect(() => getForwardedEnv()).toThrow('Permission denied');
  });
});

describe('getForwardedEnv integration with docker run args ordering', () => {
  it('returns vars in a deterministic (sorted) order', () => {
    process.env['TEST_VAR_B'] = 'b-value';
    process.env['TEST_VAR_A'] = 'a-value';
    mockReadFileSync.mockReturnValue('TEST_VAR_B\nTEST_VAR_A\n');

    const result = getForwardedEnv();
    const keys = Object.keys(result);

    // The consumer sorts before emitting -e flags; confirm both keys present
    expect(new Set(keys)).toEqual(new Set(['TEST_VAR_A', 'TEST_VAR_B']));
    expect(result['TEST_VAR_A']).toBe('a-value');
    expect(result['TEST_VAR_B']).toBe('b-value');
  });
});
