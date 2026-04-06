import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

describe('codex auth inspection', () => {
  const originalHome = process.env.HOME;
  const tempDirs: string[] = [];

  function createTempRepo(): { repoDir: string; homeDir: string } {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-auth-repo-'),
    );
    const homeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-auth-home-'),
    );

    tempDirs.push(repoDir, homeDir);
    return { repoDir, homeDir };
  }

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    spawnSyncMock.mockReset();
    vi.resetModules();

    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('accepts a file-backed ChatGPT login cache', async () => {
    // Arrange
    const { repoDir, homeDir } = createTempRepo();
    process.env.HOME = homeDir;
    const authFile = path.join(homeDir, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, 'chatgpt-cache\n');
    spawnSyncMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        options: { env: NodeJS.ProcessEnv },
      ) => {
        const codexHome = options.env.CODEX_HOME;
        const copiedAuthFile = path.join(codexHome!, 'auth.json');
        expect(fs.existsSync(copiedAuthFile)).toBe(true);
        expect(fs.readFileSync(copiedAuthFile, 'utf8')).toBe('chatgpt-cache\n');
        return {
          status: 0,
          stdout: '',
          stderr: 'Logged in using ChatGPT\n',
        };
      },
    );

    // Act
    const { inspectCodexAuth } = await import('./codex-auth.js');
    const result = inspectCodexAuth(process.env, repoDir);

    // Assert
    expect(result).toMatchObject({
      authFilePath: authFile,
      authFileExists: true,
      cliAvailable: true,
      loginMethod: 'chatgpt',
      loginSource: 'file',
      statusText: 'Logged in using ChatGPT',
    });
  });

  it('reports no login when neither a file cache nor ambient login is available', async () => {
    // Arrange
    const { repoDir, homeDir } = createTempRepo();
    process.env.HOME = homeDir;
    spawnSyncMock.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'Not logged in\n',
    });

    // Act
    const { inspectCodexAuth } = await import('./codex-auth.js');
    const result = inspectCodexAuth(process.env, repoDir);

    // Assert
    expect(result).toMatchObject({
      authFilePath: path.join(homeDir, '.codex', 'auth.json'),
      authFileExists: false,
      cliAvailable: true,
      loginMethod: 'none',
      loginSource: 'external',
      statusText: 'Not logged in',
    });
  });

  it('rejects a file-backed API-key login cache', async () => {
    // Arrange
    const { repoDir, homeDir } = createTempRepo();
    process.env.HOME = homeDir;
    const authFile = path.join(homeDir, '.codex', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, 'api-key-cache\n');
    spawnSyncMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        options: { env: NodeJS.ProcessEnv },
      ) => {
        const codexHome = options.env.CODEX_HOME;
        expect(
          fs.readFileSync(path.join(codexHome!, 'auth.json'), 'utf8'),
        ).toBe('api-key-cache\n');
        return {
          status: 0,
          stdout: '',
          stderr: 'Logged in using an API key - OpenAI\n',
        };
      },
    );

    // Act
    const { inspectCodexAuth } = await import('./codex-auth.js');
    const result = inspectCodexAuth(process.env, repoDir);

    // Assert
    expect(result).toMatchObject({
      authFilePath: authFile,
      authFileExists: true,
      cliAvailable: true,
      loginMethod: 'api_key',
      loginSource: 'file',
      statusText: 'Logged in using an API key - OpenAI',
    });
  });

  it('surfaces a ChatGPT keyring login when no file-backed cache is available', async () => {
    // Arrange
    const { repoDir, homeDir } = createTempRepo();
    process.env.HOME = homeDir;
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: '',
      stderr: 'Logged in using ChatGPT\n',
    });

    // Act
    const { inspectCodexAuth } = await import('./codex-auth.js');
    const result = inspectCodexAuth(process.env, repoDir);

    // Assert
    expect(result).toMatchObject({
      authFilePath: path.join(homeDir, '.codex', 'auth.json'),
      authFileExists: false,
      cliAvailable: true,
      loginMethod: 'chatgpt',
      loginSource: 'external',
      statusText: 'Logged in using ChatGPT',
    });
  });
});
