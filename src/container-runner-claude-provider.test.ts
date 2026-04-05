import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

interface LoadedSubject {
  runContainerAgent: typeof import('./container-runner.js').runContainerAgent;
  spawnMock: ReturnType<typeof vi.fn>;
}

const EXPECTED_CLAUDE_SETTINGS = {
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
};

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: import('./container-runner.js').ContainerOutput,
): void {
  proc.stdout.push(
    `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
  );
}

async function loadSubject(
  dataDir: string,
  groupsDir: string,
  fakeProc: ReturnType<typeof createFakeProcess>,
): Promise<LoadedSubject> {
  const spawnMock = vi.fn(() => fakeProc);

  vi.resetModules();

  vi.doMock('./config.js', () => ({
    COMPATIBILITY_AGENT_PROVIDER: 'claude-code',
    CONTAINER_IMAGE: 'nanoclaw-agent:latest',
    CONTAINER_MAX_OUTPUT_SIZE: 10485760,
    CONTAINER_TIMEOUT: 1800000,
    DATA_DIR: dataDir,
    GROUPS_DIR: groupsDir,
    IDLE_TIMEOUT: 1800000,
    ONECLI_URL: 'http://localhost:10254',
    TIMEZONE: 'UTC',
  }));

  vi.doMock('./logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  vi.doMock('./mount-security.js', () => ({
    validateAdditionalMounts: vi.fn(() => []),
  }));

  vi.doMock('./container-runtime.js', () => ({
    CONTAINER_RUNTIME_BIN: 'docker',
    hostGatewayArgs: () => [],
    readonlyMountArgs: (hostPath: string, containerPath: string) => [
      '-v',
      `${hostPath}:${containerPath}:ro`,
    ],
    stopContainer: vi.fn(),
  }));

  vi.doMock('@onecli-sh/sdk', () => ({
    OneCLI: class {
      applyContainerConfig = vi.fn().mockResolvedValue(true);
      createAgent = vi.fn().mockResolvedValue({ id: 'test' });
      ensureAgent = vi
        .fn()
        .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
    },
  }));

  vi.doMock('child_process', async () => {
    const actual =
      await vi.importActual<typeof import('child_process')>('child_process');
    return {
      ...actual,
      spawn: spawnMock,
    };
  });

  const module = await import('./container-runner.js');

  return {
    runContainerAgent: module.runContainerAgent,
    spawnMock,
  };
}

function createClaudeGroup(): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    providerId: 'claude-code',
  };
}

describe('container runner Claude provider compatibility', () => {
  let tempRoot: string;
  let dataDir: string;
  let groupsDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-container-claude-provider-'),
    );
    dataDir = path.join(tempRoot, 'data');
    groupsDir = path.join(tempRoot, 'groups');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(groupsDir, { recursive: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('materializes Claude settings, compatibility memory, skills, and mount path', async () => {
    // Arrange
    const group = createClaudeGroup();
    const groupDir = path.join(groupsDir, group.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'AGENT.md'), '# Canonical Agent\n');
    const fakeProc = createFakeProcess();
    const { runContainerAgent, spawnMock } = await loadSubject(
      dataDir,
      groupsDir,
      fakeProc,
    );

    // Act
    const runPromise = runContainerAgent(
      group,
      {
        prompt: 'Ship the Claude provider slice.',
        groupFolder: group.folder,
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
    );
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'session-123',
    });
    fakeProc.emit('close', 0);
    await runPromise;

    // Assert
    const providerStateDir = path.join(
      dataDir,
      'sessions',
      group.folder,
      'claude-code',
    );
    expect(fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf-8')).toBe(
      '# Canonical Agent\n',
    );
    expect(
      JSON.parse(
        fs.readFileSync(path.join(providerStateDir, 'settings.json'), 'utf-8'),
      ),
    ).toEqual(EXPECTED_CLAUDE_SETTINGS);
    expect(
      fs.existsSync(
        path.join(providerStateDir, 'skills', 'status', 'SKILL.md'),
      ),
    ).toBe(true);
    expect(spawnMock.mock.calls[0][1]).toContain(
      `${providerStateDir}:/home/node/.claude`,
    );
  });

  it('mounts legacy .claude state when the new provider namespace is empty', async () => {
    // Arrange
    const group = createClaudeGroup();
    const groupDir = path.join(groupsDir, group.folder);
    const legacyStateDir = path.join(
      dataDir,
      'sessions',
      group.folder,
      '.claude',
    );
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'AGENT.md'), '# Canonical Agent\n');
    fs.mkdirSync(legacyStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyStateDir, 'sessions-index.json'),
      JSON.stringify({ entries: [{ sessionId: 'legacy-session' }] }),
    );
    const fakeProc = createFakeProcess();
    const { runContainerAgent, spawnMock } = await loadSubject(
      dataDir,
      groupsDir,
      fakeProc,
    );

    // Act
    const runPromise = runContainerAgent(
      group,
      {
        prompt: 'Resume the legacy Claude session.',
        groupFolder: group.folder,
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
    );
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'ok',
      newSessionId: 'legacy-session',
    });
    fakeProc.emit('close', 0);
    await runPromise;

    // Assert
    expect(spawnMock.mock.calls[0][1]).toContain(
      `${legacyStateDir}:/home/node/.claude`,
    );
    expect(fs.existsSync(path.join(legacyStateDir, 'settings.json'))).toBe(
      true,
    );
  });
});
