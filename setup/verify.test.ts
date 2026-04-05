import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Database from 'better-sqlite3';

const {
  emitStatus,
  execSyncMock,
  getPlatform,
  getServiceManager,
  hasSystemd,
  isRoot,
} = vi.hoisted(() => ({
  emitStatus: vi.fn(),
  execSyncMock: vi.fn(),
  getPlatform: vi.fn(() => 'linux'),
  getServiceManager: vi.fn(() => 'none'),
  hasSystemd: vi.fn(() => false),
  isRoot: vi.fn(() => false),
}));

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('./platform.js', () => ({
  getPlatform,
  getServiceManager,
  hasSystemd,
  isRoot,
}));

vi.mock('./status.js', () => ({
  emitStatus,
}));

describe('verify provider readiness', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const providerEnvKeys = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
  ] as const;
  const tempDirs: string[] = [];

  function createTempRepo(): { repoDir: string; homeDir: string } {
    const repoDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-verify-test-'),
    );
    const homeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-verify-home-'),
    );

    tempDirs.push(repoDir, homeDir);
    fs.mkdirSync(path.join(repoDir, 'store'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.config', 'nanoclaw'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json'),
      '{}\n',
    );

    return { repoDir, homeDir };
  }

  function seedRegisteredGroup(repoDir: string): void {
    const db = new Database(path.join(repoDir, 'store', 'messages.db'));

    try {
      db.exec(`CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        container_config TEXT,
        provider_id TEXT,
        provider_options TEXT,
        requires_trigger INTEGER DEFAULT 1,
        is_main INTEGER DEFAULT 0
      )`);
      db.prepare(
        `INSERT INTO registered_groups (
          jid,
          name,
          folder,
          trigger_pattern,
          added_at,
          provider_id,
          requires_trigger,
          is_main
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'main@g.us',
        'Main',
        'main',
        '@Andy',
        '2026-04-03T00:00:00.000Z',
        'claude-code',
        1,
        1,
      );
    } finally {
      db.close();
    }
  }

  async function runVerify(repoDir: string): Promise<Record<string, string>> {
    process.chdir(repoDir);
    vi.resetModules();
    const { run } = await import('./verify.ts');
    await run([]);
    return emitStatus.mock.calls.at(-1)?.[1] as Record<string, string>;
  }

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    emitStatus.mockReset();
    execSyncMock.mockReset();
    getPlatform.mockReset();
    getPlatform.mockReturnValue('linux');
    getServiceManager.mockReset();
    getServiceManager.mockReturnValue('none');
    hasSystemd.mockReset();
    hasSystemd.mockReturnValue(false);
    isRoot.mockReset();
    isRoot.mockReturnValue(false);
    vi.restoreAllMocks();
    vi.resetModules();
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('emits readiness and capability flags per provider', async () => {
    // Arrange
    const { repoDir, homeDir } = createTempRepo();
    process.env.HOME = homeDir;
    fs.writeFileSync(
      path.join(repoDir, '.env'),
      [
        'ANTHROPIC_API_KEY=anthropic-test',
        'OPENAI_API_KEY=openai-test',
        'TELEGRAM_BOT_TOKEN=telegram-test',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(path.join(repoDir, 'nanoclaw.pid'), `${process.pid}\n`);
    seedRegisteredGroup(repoDir);
    execSyncMock.mockImplementation((command: string) => {
      if (command === 'command -v container') {
        throw new Error('container missing');
      }
      if (command === 'docker info') {
        return '';
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    // Act
    const status = await runVerify(repoDir);
    const providers = JSON.parse(status.PROVIDERS) as Array<{
      id: string;
      ready: boolean;
      capabilities: {
        agentTeams: boolean;
      };
    }>;

    // Assert
    expect(status.STATUS).toBe('success');
    expect(status.PROVIDER_READINESS).toBe('configured');
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-code',
          ready: true,
          capabilities: expect.objectContaining({
            agentTeams: true,
          }),
        }),
        expect.objectContaining({
          id: 'codex',
          ready: true,
          capabilities: expect.objectContaining({
            agentTeams: false,
          }),
        }),
      ]),
    );
  });

  it('marks only the matching provider ready when credentials are mixed', async () => {
    // Arrange
    const { repoDir, homeDir } = createTempRepo();
    process.env.HOME = homeDir;
    fs.writeFileSync(
      path.join(repoDir, '.env'),
      [
        'OPENAI_API_KEY=openai-test',
        'TELEGRAM_BOT_TOKEN=telegram-test',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(path.join(repoDir, 'nanoclaw.pid'), `${process.pid}\n`);
    seedRegisteredGroup(repoDir);
    execSyncMock.mockImplementation((command: string) => {
      if (command === 'command -v container') {
        throw new Error('container missing');
      }
      if (command === 'docker info') {
        return '';
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const originalProviderEnv = Object.fromEntries(
      providerEnvKeys.map((key) => [key, process.env[key]]),
    ) as Record<(typeof providerEnvKeys)[number], string | undefined>;

    for (const key of providerEnvKeys) {
      delete process.env[key];
    }

    try {
      // Act
      const status = await runVerify(repoDir);
      const providers = JSON.parse(status.PROVIDERS) as Array<{
        id: string;
        ready: boolean;
      }>;

      // Assert
      expect(status.STATUS).toBe('success');
      expect(status.PROVIDER_READINESS).toBe('configured');
      expect(providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'claude-code',
            ready: false,
          }),
          expect.objectContaining({
            id: 'codex',
            ready: true,
          }),
        ]),
      );
    } finally {
      for (const key of providerEnvKeys) {
        const value = originalProviderEnv[key];
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it('does not treat ONECLI_URL or channel auth as provider readiness', async () => {
    // Arrange
    const { repoDir, homeDir } = createTempRepo();
    process.env.HOME = homeDir;
    fs.writeFileSync(
      path.join(repoDir, '.env'),
      [
        'ONECLI_URL=http://onecli.invalid',
        'TELEGRAM_BOT_TOKEN=telegram-test',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(path.join(repoDir, 'nanoclaw.pid'), `${process.pid}\n`);
    seedRegisteredGroup(repoDir);
    execSyncMock.mockImplementation((command: string) => {
      if (command === 'command -v container') {
        throw new Error('container missing');
      }
      if (command === 'docker info') {
        return '';
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    // Act
    const status = await runVerify(repoDir);
    const providers = JSON.parse(status.PROVIDERS) as Array<{
      id: string;
      ready: boolean;
    }>;

    // Assert
    expect(status.STATUS).toBe('failed');
    expect(status.PROVIDER_READINESS).toBe('missing');
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-code',
          ready: false,
        }),
        expect.objectContaining({
          id: 'codex',
          ready: false,
        }),
      ]),
    );
  });
});
