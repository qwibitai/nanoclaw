import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readEnvFile } from './env.js';

describe('readEnvFile', () => {
  const originalCwd = process.cwd();
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-env-'));
    process.chdir(tempDir);
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads values from .env when process env is unset', () => {
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'ANTHROPIC_API_KEY=file-key\nCLAUDE_CODE_OAUTH_TOKEN=file-oauth\n',
    );

    expect(
      readEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']),
    ).toEqual({
      ANTHROPIC_API_KEY: 'file-key',
      CLAUDE_CODE_OAUTH_TOKEN: 'file-oauth',
    });
  });

  it('prefers process env over .env', () => {
    fs.writeFileSync(
      path.join(tempDir, '.env'),
      'ANTHROPIC_API_KEY=file-key\n',
    );
    process.env.ANTHROPIC_API_KEY = 'process-key';

    expect(readEnvFile(['ANTHROPIC_API_KEY'])).toEqual({
      ANTHROPIC_API_KEY: 'process-key',
    });
  });

  it('returns injected process env even when .env is missing', () => {
    process.env.ANTHROPIC_API_KEY = 'process-key';

    expect(readEnvFile(['ANTHROPIC_API_KEY'])).toEqual({
      ANTHROPIC_API_KEY: 'process-key',
    });
  });
});
