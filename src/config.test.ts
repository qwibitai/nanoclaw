import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

function restoreProcessEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createTempRepo(envFileContent?: string): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-config-test-'),
  );

  if (envFileContent) {
    fs.writeFileSync(path.join(tempDir, '.env'), envFileContent);
  }

  return tempDir;
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  restoreProcessEnv();
  vi.resetModules();
});

describe('DEFAULT_AGENT_PROVIDER', () => {
  it('defaults to claude-code when no provider is configured', async () => {
    // Arrange
    delete process.env.DEFAULT_AGENT_PROVIDER;
    const tempDir = createTempRepo();
    process.chdir(tempDir);

    // Act
    const { DEFAULT_AGENT_PROVIDER } = await import('./config.js');

    // Assert
    expect(DEFAULT_AGENT_PROVIDER).toBe('claude-code');
  });

  it('loads the configured provider from .env', async () => {
    // Arrange
    delete process.env.DEFAULT_AGENT_PROVIDER;
    const tempDir = createTempRepo('DEFAULT_AGENT_PROVIDER=codex\n');
    process.chdir(tempDir);

    // Act
    const { DEFAULT_AGENT_PROVIDER } = await import('./config.js');

    // Assert
    expect(DEFAULT_AGENT_PROVIDER).toBe('codex');
  });

  it('rejects unknown configured providers', async () => {
    // Arrange
    process.env.DEFAULT_AGENT_PROVIDER = 'missing-provider';
    const tempDir = createTempRepo();
    process.chdir(tempDir);

    // Act
    const loadConfig = async () => import('./config.js');

    // Assert
    await expect(loadConfig()).rejects.toThrowError(
      /DEFAULT_AGENT_PROVIDER.*missing-provider/,
    );
  });
});
