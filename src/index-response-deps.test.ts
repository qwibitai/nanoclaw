import { describe, test, expect, vi } from 'vitest';

// Mock all heavy dependencies so index.ts can be imported without side effects
vi.mock('./db.js', () => ({
  initDatabase: vi.fn(),
  getMessagesSince: vi.fn(() => []),
  getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
  storeMessage: vi.fn(),
  storeChatMetadata: vi.fn(),
  getAllTasks: vi.fn(() => []),
  getTaskById: vi.fn(),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  getSession: vi.fn(),
  setSession: vi.fn(),
}));
vi.mock('./channels/index.js', () => ({}));
vi.mock('./channels/registry.js', () => ({
  getChannelFactory: vi.fn(),
  getRegisteredChannelNames: vi.fn(() => []),
  registerChannel: vi.fn(),
}));
vi.mock('./channels/telegram.js', () => ({
  initBotPool: vi.fn(),
  sendPoolMessage: vi.fn(),
}));
vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
  writeCasesSnapshot: vi.fn(),
}));
vi.mock('./container-runtime.js', () => ({
  ensureContainerRuntimeRunning: vi.fn(),
  cleanupOrphans: vi.fn(),
  PROXY_BIND_HOST: '0.0.0.0',
}));
vi.mock('./credential-proxy.js', () => ({
  startCredentialProxy: vi.fn(),
}));
vi.mock('./cases.js', () => ({
  getActiveCases: vi.fn(() => []),
  getRoutableCases: vi.fn(() => []),
  getSuggestedCases: vi.fn(() => []),
  getCaseById: vi.fn(),
  insertCase: vi.fn(),
  updateCase: vi.fn(),
  addCaseTime: vi.fn(),
  generateCaseId: vi.fn(),
  generateCaseName: vi.fn(),
  createCaseWorkspace: vi.fn(),
  pruneCaseWorkspace: vi.fn(),
  suggestDevCase: vi.fn(),
  getStaleActiveCases: vi.fn(() => []),
  getStaleDoneCases: vi.fn(() => []),
  getActiveCasesByGithubIssue: vi.fn(() => []),
  removeWorktreeLock: vi.fn(),
  updateWorktreeLockHeartbeat: vi.fn(),
  formatCaseStatus: vi.fn(),
}));
vi.mock('./case-router.js', () => ({
  routeMessage: vi.fn(),
}));
vi.mock('./router-container.js', () => ({
  startRouterContainer: vi.fn(),
  stopRouterContainer: vi.fn(),
}));
vi.mock('./ipc.js', () => ({
  startIpcWatcher: vi.fn(),
}));
vi.mock('./task-scheduler.js', () => ({
  startSchedulerLoop: vi.fn(),
}));
vi.mock('./group-queue.js', () => ({
  GroupQueue: class MockGroupQueue {
    enqueueMessageCheck = vi.fn();
    setProcessMessagesFn = vi.fn();
    setDownloadTracker = vi.fn();
    registerProcess = vi.fn();
    closeStdin = vi.fn();
    sendMessage = vi.fn();
    notifyIdle = vi.fn();
    shutdown = vi.fn();
  },
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
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'TestBot',
  TELEGRAM_BOT_POOL: ['token1'],
  CREDENTIAL_PROXY_PORT: 3001,
  IDLE_TIMEOUT: 300000,
  POLL_INTERVAL: 2000,
  TIMEZONE: 'UTC',
  TRIGGER_PATTERN: /^@TestBot\b/i,
  DATA_DIR: '/tmp/nanoclaw-test',
  IPC_POLL_INTERVAL: 1000,
  COALESCE_MS: 0,
  MAX_DOWNLOAD_WAIT_MS: 60000,
}));
vi.mock('./download-tracker.js', () => ({
  DownloadTracker: class MockDownloadTracker {
    start = vi.fn();
    complete = vi.fn();
    hasPending = vi.fn(() => false);
  },
}));
vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('./sender-allowlist.js', () => ({
  loadSenderAllowlist: vi.fn(() => ({})),
  isTriggerAllowed: vi.fn(() => true),
  shouldAutoTrigger: vi.fn(() => false),
  shouldDropMessage: vi.fn(() => false),
  isSenderAllowed: vi.fn(() => true),
}));
vi.mock('./remote-control.js', () => ({
  startRemoteControl: vi.fn(),
  stopRemoteControl: vi.fn(),
  restoreRemoteControl: vi.fn(),
}));
vi.mock('./router.js', () => ({
  findChannel: vi.fn(),
  formatMessages: vi.fn(() => ''),
  formatOutbound: vi.fn((t: string) => t),
}));
vi.mock('./github-issues.js', () => ({
  createGitHubIssue: vi.fn(),
  DEV_CASE_ISSUE_REPO: 'test/repo',
}));
vi.mock('./usage.js', () => ({
  recordUsage: vi.fn(),
}));
vi.mock('./group-folder.js', () => ({
  cleanupStaleUploads: vi.fn(),
  resolveGroupFolderPath: vi.fn((f: string) => `/tmp/groups/${f}`),
}));

import { makeResponseDeps } from './index.js';
import type { Channel } from './types.js';

describe('makeResponseDeps', () => {
  // INVARIANT: makeResponseDeps produces deps with sendMessage wired to channel
  // SUT: makeResponseDeps channel wiring
  test('wires sendMessage to channel.sendMessage', async () => {
    const mockChannel: Channel = {
      name: 'telegram',
      connect: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn(() => true),
      disconnect: vi.fn(),
    };

    const deps = makeResponseDeps(mockChannel);
    await deps.sendMessage('tg:123', 'hello');

    expect(mockChannel.sendMessage).toHaveBeenCalledWith('tg:123', 'hello');
  });

  // INVARIANT: makeResponseDeps includes sendPoolMessage when TELEGRAM_BOT_POOL is configured
  // SUT: makeResponseDeps pool wiring
  test('includes sendPoolMessage when pool tokens configured', () => {
    const mockChannel: Channel = {
      name: 'telegram',
      connect: vi.fn(),
      sendMessage: vi.fn(),
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn(() => true),
      disconnect: vi.fn(),
    };

    const deps = makeResponseDeps(mockChannel);
    expect(deps.sendPoolMessage).toBeDefined();
  });
});
