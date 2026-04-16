import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';

import { readEnvFile } from './env.js';

describe('readEnvFile', () => {
  const cwd = process.cwd();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns requested keys from a .env file', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      '# comment\nFOO=bar\nBAZ="quoted"\nQUX=\'single\'\nIGNORED=yes\n',
    );
    const result = readEnvFile(['FOO', 'BAZ', 'QUX']);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'quoted', QUX: 'single' });
  });

  it('ignores keys not in the requested list', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('WANTED=yes\nUNWANTED=no\n');
    expect(readEnvFile(['WANTED'])).toEqual({ WANTED: 'yes' });
  });

  it('skips blank lines, comments, and malformed lines', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      '\n# hello\nNOEQUALS_LINE\nOK=1\n',
    );
    expect(readEnvFile(['OK', 'NOEQUALS_LINE'])).toEqual({ OK: '1' });
  });

  it('drops keys that resolve to an empty value', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('EMPTY=\n  SPACED=  \n');
    expect(readEnvFile(['EMPTY', 'SPACED'])).toEqual({});
  });

  it('returns an empty object when .env is missing', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(readEnvFile(['ANYTHING'])).toEqual({});
  });

  it('reads .env from the current working directory', () => {
    const spy = vi.spyOn(fs, 'readFileSync').mockReturnValue('KEY=value\n');
    readEnvFile(['KEY']);
    expect(spy).toHaveBeenCalledWith(`${cwd}/.env`, 'utf-8');
  });
});
