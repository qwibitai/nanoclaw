import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredGroup } from './types.js';

const {
  deleteSession,
  ensureAgent,
  getAllRegisteredGroups,
  getSession,
  runContainerAgent,
  setRegisteredGroup,
  setSession,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  ensureAgent: vi
    .fn()
    .mockResolvedValue({ name: 'test', identifier: 'test', created: true }),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getSession: vi.fn(() => undefined),
  runContainerAgent: vi.fn(),
  setRegisteredGroup: vi.fn(),
  setSession: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = ensureAgent;
  },
}));

vi.mock('./channels/index.js', () => ({}));

vi.mock('./channels/registry.js', () => ({
  getChannelFactory: vi.fn(),
  getRegisteredChannelNames: vi.fn(() => []),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
}));

vi.mock('./container-runtime.js', () => ({
  cleanupOrphans: vi.fn(),
  ensureContainerRuntimeRunning: vi.fn(),
}));

vi.mock('./db.js', () => ({
  deleteSession,
  getAllChats: vi.fn(() => []),
  getAllRegisteredGroups,
  getAllSessions: vi.fn(() => ({})),
  getAllTasks: vi.fn(() => []),
  getLastBotMessageTimestamp: vi.fn(() => ''),
  getMessagesSince: vi.fn(() => []),
  getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
  getSession,
  getRouterState: vi.fn(() => ''),
  initDatabase: vi.fn(),
  setRegisteredGroup,
  setRouterState: vi.fn(),
  setSession,
  storeChatMetadata: vi.fn(),
  storeMessage: vi.fn(),
}));

vi.mock('./group-queue.js', () => ({
  GroupQueue: class {
    closeStdin = vi.fn();
    enqueueMessageCheck = vi.fn();
    notifyIdle = vi.fn();
    registerProcess = vi.fn();
    sendMessage = vi.fn(() => false);
    setProcessMessagesFn = vi.fn();
    shutdown = vi.fn(async () => {});
  },
}));

vi.mock('./ipc.js', () => ({
  startIpcWatcher: vi.fn(),
}));

vi.mock('./router.js', () => ({
  escapeXml: vi.fn((value: string) => value),
  findChannel: vi.fn(),
  formatMessages: vi.fn(() => ''),
  formatOutbound: vi.fn((value: string) => value),
}));

vi.mock('./remote-control.js', () => ({
  restoreRemoteControl: vi.fn(),
  startRemoteControl: vi.fn(),
  stopRemoteControl: vi.fn(),
}));

vi.mock('./sender-allowlist.js', () => ({
  isSenderAllowed: vi.fn(() => true),
  isTriggerAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({ mode: 'allow' })),
  shouldDropMessage: vi.fn(() => false),
}));

vi.mock('./task-scheduler.js', () => ({
  startSchedulerLoop: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

const ORIGINAL_CWD = process.cwd();

function readBundledGlobalTemplate(): string {
  return fs.readFileSync(
    path.join(ORIGINAL_CWD, 'groups', 'global', 'AGENT.md'),
    'utf-8',
  );
}

function readBundledMainTemplate(): string {
  return fs.readFileSync(
    path.join(ORIGINAL_CWD, 'groups', 'main', 'AGENT.md'),
    'utf-8',
  );
}

function createTempRepo(): string {
  const repoDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-index-test-'),
  );
  fs.mkdirSync(path.join(repoDir, 'groups', 'main'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'groups', 'global'), { recursive: true });
  return repoDir;
}

function writeGroupFile(
  repoDir: string,
  groupFolder: string,
  fileName: string,
  content: string,
): string {
  const filePath = path.join(repoDir, 'groups', groupFolder, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function readGroupFile(
  repoDir: string,
  groupFolder: string,
  fileName: string,
): string {
  return fs.readFileSync(
    path.join(repoDir, 'groups', groupFolder, fileName),
    'utf-8',
  );
}

async function loadIndexModule(repoDir: string) {
  process.chdir(repoDir);
  vi.resetModules();
  return import('./index.js');
}

describe('startup group registration memory seeding', () => {
  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    vi.resetModules();
    deleteSession.mockReset();
    setRegisteredGroup.mockReset();
    ensureAgent.mockClear();
    getAllRegisteredGroups.mockReset();
    getAllRegisteredGroups.mockReturnValue({});
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    runContainerAgent.mockReset();
    setSession.mockReset();
    writeGroupsSnapshot.mockReset();
    writeTasksSnapshot.mockReset();
  });

  it('seeds new groups from canonical global AGENT.md and renders CLAUDE.md from it', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'global',
      'AGENT.md',
      '# Canonical Global\n\nYou are Andy, a personal assistant.\n',
    );
    writeGroupFile(
      repoDir,
      'global',
      'CLAUDE.md',
      '# Compatibility Global\n\nThis should never become canonical.\n',
    );
    const group: RegisteredGroup = {
      name: 'Dev Team',
      folder: 'telegram_dev_team',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
    };

    // Act
    const { _registerGroupForTest } = await loadIndexModule(repoDir);
    _registerGroupForTest('tg:-1002', group);

    // Assert
    expect(readGroupFile(repoDir, 'telegram_dev_team', 'AGENT.md')).toBe(
      '# Canonical Global\n\nYou are Andy, a personal assistant.\n',
    );
    expect(readGroupFile(repoDir, 'telegram_dev_team', 'CLAUDE.md')).toBe(
      '# Canonical Global\n\nYou are Andy, a personal assistant.\n',
    );
    expect(setRegisteredGroup).toHaveBeenCalledWith('tg:-1002', group);
    expect(ensureAgent).toHaveBeenCalled();
  });

  it('seeds AGENT.md from an existing CLAUDE.md during startup registration', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'global',
      'AGENT.md',
      '# Global Template\n\nYou are Andy.\n',
    );
    writeGroupFile(
      repoDir,
      'slack_product',
      'CLAUDE.md',
      '# Product Memory\n\nKeep this custom workflow exactly.\n',
    );
    const group: RegisteredGroup = {
      name: 'Product',
      folder: 'slack_product',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
    };

    // Act
    const { _registerGroupForTest } = await loadIndexModule(repoDir);
    _registerGroupForTest('slack:C123', group);

    // Assert
    expect(readGroupFile(repoDir, 'slack_product', 'AGENT.md')).toBe(
      '# Product Memory\n\nKeep this custom workflow exactly.\n',
    );
    expect(readGroupFile(repoDir, 'slack_product', 'CLAUDE.md')).toBe(
      '# Product Memory\n\nKeep this custom workflow exactly.\n',
    );
  });

  it('does not overwrite existing AGENT.md or CLAUDE.md during startup registration', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'main',
      'AGENT.md',
      '# Main Template\n\n## Admin Context\n',
    );
    writeGroupFile(
      repoDir,
      'discord_main',
      'AGENT.md',
      '# Custom Canonical\n\nPreserve this.\n',
    );
    writeGroupFile(
      repoDir,
      'discord_main',
      'CLAUDE.md',
      '# Custom Compatibility\n\nPreserve this too.\n',
    );
    const group: RegisteredGroup = {
      name: 'Control',
      folder: 'discord_main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
    };

    // Act
    const { _registerGroupForTest } = await loadIndexModule(repoDir);
    _registerGroupForTest('dc:main', group);

    // Assert
    expect(readGroupFile(repoDir, 'discord_main', 'AGENT.md')).toBe(
      '# Custom Canonical\n\nPreserve this.\n',
    );
    expect(readGroupFile(repoDir, 'discord_main', 'CLAUDE.md')).toBe(
      '# Custom Compatibility\n\nPreserve this too.\n',
    );
  });

  it('promotes legacy main CLAUDE.md during runtime registration for groups/main', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(repoDir, 'main', 'AGENT.md', readBundledMainTemplate());
    writeGroupFile(
      repoDir,
      'main',
      'CLAUDE.md',
      '# Existing Main Memory\n\nKeep this control-room context.\n',
    );
    const group: RegisteredGroup = {
      name: 'Control',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
    };

    // Act
    const { _registerGroupForTest } = await loadIndexModule(repoDir);
    _registerGroupForTest('dc:main', group);

    // Assert
    expect(readGroupFile(repoDir, 'main', 'AGENT.md')).toBe(
      '# Existing Main Memory\n\nKeep this control-room context.\n',
    );
    expect(readGroupFile(repoDir, 'main', 'CLAUDE.md')).toBe(
      '# Existing Main Memory\n\nKeep this control-room context.\n',
    );
  });

  it('backfills AGENT.md for existing registered groups during startup recovery', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'global',
      'AGENT.md',
      '# Global Template\n\nYou are Andy.\n',
    );
    writeGroupFile(
      repoDir,
      'slack_ops',
      'CLAUDE.md',
      '# Existing Legacy Memory\n\nKeep the runbook exactly.\n',
    );
    const group: RegisteredGroup = {
      name: 'Ops',
      folder: 'slack_ops',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
    };

    // Act
    const { _restoreRegisteredGroupsOnStartupForTest } =
      await loadIndexModule(repoDir);
    _restoreRegisteredGroupsOnStartupForTest({ 'slack:C456': group });

    // Assert
    expect(readGroupFile(repoDir, 'slack_ops', 'AGENT.md')).toBe(
      '# Existing Legacy Memory\n\nKeep the runbook exactly.\n',
    );
    expect(readGroupFile(repoDir, 'slack_ops', 'CLAUDE.md')).toBe(
      '# Existing Legacy Memory\n\nKeep the runbook exactly.\n',
    );
    expect(ensureAgent).toHaveBeenCalled();
  });

  it('promotes legacy global CLAUDE.md into AGENT.md once during startup recovery', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(repoDir, 'global', 'AGENT.md', readBundledGlobalTemplate());
    writeGroupFile(
      repoDir,
      'global',
      'CLAUDE.md',
      '# Existing Global Memory\n\nKeep this shared context.\n',
    );

    // Act
    const { _restoreRegisteredGroupsOnStartupForTest } =
      await loadIndexModule(repoDir);
    _restoreRegisteredGroupsOnStartupForTest({});

    // Assert
    expect(readGroupFile(repoDir, 'global', 'AGENT.md')).toBe(
      '# Existing Global Memory\n\nKeep this shared context.\n',
    );

    writeGroupFile(
      repoDir,
      'global',
      'CLAUDE.md',
      '# Later Compatibility Edit\n',
    );
    _restoreRegisteredGroupsOnStartupForTest({});
    expect(readGroupFile(repoDir, 'global', 'AGENT.md')).toBe(
      '# Existing Global Memory\n\nKeep this shared context.\n',
    );
  });
});

describe('provider-scoped runtime sessions', () => {
  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    vi.resetModules();
    deleteSession.mockReset();
    getAllRegisteredGroups.mockReset();
    getAllRegisteredGroups.mockReturnValue({});
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    runContainerAgent.mockReset();
    setSession.mockReset();
    writeGroupsSnapshot.mockReset();
    writeTasksSnapshot.mockReset();
  });

  it('uses the current provider session after a provider switch at runtime', async () => {
    // Arrange
    const repoDir = createTempRepo();
    const startupGroup: RegisteredGroup = {
      name: 'Codex Group',
      folder: 'codex-group',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      providerId: 'claude-code',
    };
    const runtimeGroup: RegisteredGroup = {
      ...startupGroup,
      providerId: 'codex',
    };
    getAllRegisteredGroups.mockReturnValue({ 'codex@g.us': startupGroup });
    getSession.mockImplementation(
      (groupFolder: string, providerId: string | undefined) => {
        if (groupFolder !== 'codex-group') {
          return undefined;
        }
        if (providerId === 'claude-code') {
          return 'claude-session';
        }
        if (providerId === 'codex') {
          return 'codex-session-current';
        }
        return undefined;
      },
    );
    runContainerAgent.mockResolvedValue({
      status: 'success',
      result: 'done',
      newSessionId: 'codex-session-next',
    });

    // Act
    const { _loadStateForTest, _runAgentForTest, _setRegisteredGroups } =
      await loadIndexModule(repoDir);
    _loadStateForTest();
    _setRegisteredGroups({ 'codex@g.us': runtimeGroup });
    const result = await _runAgentForTest(runtimeGroup, 'Run', 'codex@g.us');

    // Assert
    expect(result).toBe('success');
    expect(getSession.mock.calls).toEqual([
      ['codex-group', 'claude-code'],
      ['codex-group', 'codex'],
    ]);
    expect(runContainerAgent).toHaveBeenCalledTimes(1);
    const [runtimeGroupArg, invocation] = runContainerAgent.mock.calls[0];
    expect(runtimeGroupArg).toEqual(
      expect.objectContaining({
        folder: 'codex-group',
        providerId: 'codex',
      }),
    );
    expect(invocation).toEqual(
      expect.objectContaining({
        prompt: 'Run',
        sessionId: 'codex-session-current',
        groupFolder: 'codex-group',
        chatJid: 'codex@g.us',
      }),
    );
    expect(setSession).toHaveBeenCalledWith(
      'codex-group',
      'codex-session-next',
      'codex',
    );
  });

  it('clears only the active provider session when the runtime reports a stale session', async () => {
    // Arrange
    const repoDir = createTempRepo();
    const group: RegisteredGroup = {
      name: 'Codex Group',
      folder: 'codex-group',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      providerId: 'codex',
    };
    getAllRegisteredGroups.mockReturnValue({ 'codex@g.us': group });
    getSession.mockImplementation(
      (groupFolder: string, providerId: string | undefined) => {
        if (groupFolder !== 'codex-group') {
          return undefined;
        }
        if (providerId === 'codex') {
          return 'codex-stale-session';
        }
        if (providerId === 'claude-code') {
          return 'claude-session';
        }
        return undefined;
      },
    );
    runContainerAgent.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'no conversation found for session',
    });

    // Act
    const { _loadStateForTest, _runAgentForTest } =
      await loadIndexModule(repoDir);
    _loadStateForTest();
    const result = await _runAgentForTest(group, 'Run', 'codex@g.us');

    // Assert
    expect(result).toBe('error');
    expect(deleteSession).toHaveBeenCalledWith('codex-group', 'codex');
    expect(deleteSession).not.toHaveBeenCalledWith(
      'codex-group',
      'claude-code',
    );
  });
});
