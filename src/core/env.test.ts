import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readEnvFile } from './env.js';

describe('readEnvFile', () => {
  const originalCwd = process.cwd();
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'env-test-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function writeEnv(content: string): void {
    fs.writeFileSync(path.join(tmpDir, '.env'), content);
  }

  it('returns empty object when .env file does not exist', () => {
    const result = readEnvFile(['KEY']);
    expect(result).toEqual({});
  });

  it('parses simple key=value pairs', () => {
    writeEnv('FOO=bar\nBAZ=qux');
    const result = readEnvFile(['FOO', 'BAZ']);
    expect(result).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('only returns requested keys', () => {
    writeEnv('FOO=bar\nBAZ=qux');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('skips comments and empty lines', () => {
    writeEnv('# comment\n\nFOO=bar\n  \n# another comment');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('skips lines without equals sign', () => {
    // Cover line 28: eqIdx === -1 continue
    writeEnv('NOEQUALSSIGN\nFOO=bar');
    const result = readEnvFile(['FOO', 'NOEQUALSSIGN']);
    expect(result).toEqual({ FOO: 'bar' });
  });

  it('strips double quotes from values', () => {
    // Cover lines 33-37: double quote stripping
    writeEnv('FOO="hello world"');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'hello world' });
  });

  it('strips single quotes from values', () => {
    // Cover lines 35-37: single quote stripping
    writeEnv("FOO='hello world'");
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'hello world' });
  });

  it('does not strip mismatched quotes', () => {
    writeEnv('FOO="hello world\'');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: '"hello world\'' });
  });

  it('skips empty values after trimming', () => {
    // Cover line 39: if (value) check
    writeEnv('FOO=\nBAR=val');
    const result = readEnvFile(['FOO', 'BAR']);
    expect(result).toEqual({ BAR: 'val' });
  });

  it('handles values with equals signs', () => {
    writeEnv('FOO=bar=baz=qux');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'bar=baz=qux' });
  });

  it('trims whitespace around keys and values', () => {
    writeEnv('  FOO  =  bar  ');
    const result = readEnvFile(['FOO']);
    expect(result).toEqual({ FOO: 'bar' });
  });
});
