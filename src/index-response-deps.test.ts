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
  getGroupUsageCategory: vi.fn(() => 'default'),
  insertUsageRecord: vi.fn(),
  getRouterState: vi.fn(),
  setRouterState: vi.fn(),
  getAllSessions: vi.fn(() => ({})),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getAllChats: vi.fn(() => []),
  getRegisteredGroup: vi.fn(),
  setRegisteredGroup: vi.fn(),
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
  detectAuthMode: vi.fn(() => 'api-key'),
}));
vi.mock('./cases.js', () => ({
  getActiveCases: vi.fn(() => []),
  getRoutableCases: vi.fn(() => []),
  getSuggestedCases: vi.fn(() => []),
  getCaseById: vi.fn(),
  insertCase: vi.fn(),
  updateCase: vi.fn(),
  addCaseCost: vi.fn(),
  addCaseTime: vi.fn(),
  generateCaseId: vi.fn(),
  registerCaseMutationHook: vi.fn(),
  writeCasesSnapshot: vi.fn(),
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
  DEV_SAFE_WORDS: ['test-dev-word'],
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

import {
  makeResponseDeps,
  buildAckPrefix,
  detectDevSafeWord,
} from './index.js';
import type { Channel } from './types.js';

describe('buildAckPrefix', () => {
  // INVARIANT: Case prefix must be a single-line prefix (space-separated, no newline)
  // SUT: buildAckPrefix
  // VERIFICATION: Prefix contains space separator, not newline
  test('returns space-separated prefix for active case', () => {
    const result = buildAckPrefix({ name: 'fix-auth' });
    expect(result).toBe('[case: fix-auth] ');
    expect(result).not.toContain('\n');
  });

  test('returns empty string when no case', () => {
    expect(buildAckPrefix(null)).toBe('');
    expect(buildAckPrefix(undefined)).toBe('');
  });

  test('prefix concatenates with emoji on one line', () => {
    const message = `${buildAckPrefix({ name: 'my-case' })}⏳ Still working...`;
    expect(message).toBe('[case: my-case] ⏳ Still working...');
    expect(message.split('\n')).toHaveLength(1);
  });
});

describe('detectDevSafeWord', () => {
  // INVARIANT: Safe word in message content must be detected and stripped
  // SUT: detectDevSafeWord
  // VERIFICATION: Returns found=true and content without the safe word

  test('detects safe word in message', () => {
    const result = detectDevSafeWord(
      '@GarssonPrintsBot test-dev-word fix the glossary',
    );
    expect(result.found).toBe(true);
    expect(result.strippedContent).toBe('@GarssonPrintsBot fix the glossary');
  });

  test('strips safe word from middle of message', () => {
    const result = detectDevSafeWord(
      'please test-dev-word start working on this',
    );
    expect(result.found).toBe(true);
    expect(result.strippedContent).toBe('please start working on this');
  });

  test('returns found=false when no safe word present', () => {
    const result = detectDevSafeWord(
      '@GarssonPrintsBot turn this pdf into jpg',
    );
    expect(result.found).toBe(false);
    expect(result.strippedContent).toBe(
      '@GarssonPrintsBot turn this pdf into jpg',
    );
  });

  test('handles safe word as only content', () => {
    const result = detectDevSafeWord('test-dev-word');
    expect(result.found).toBe(true);
    expect(result.strippedContent).toBe('');
  });

  test('collapses extra whitespace after stripping', () => {
    const result = detectDevSafeWord('fix  test-dev-word  the bug');
    expect(result.found).toBe(true);
    expect(result.strippedContent).not.toContain('  ');
  });

  test('detects group-specific safe word', () => {
    const result = detectDevSafeWord('devmode fix something', ['devmode']);
    expect(result.found).toBe(true);
    expect(result.strippedContent).toBe('fix something');
  });

  test('detects global safe word even when group words provided', () => {
    const result = detectDevSafeWord('test-dev-word fix it', ['other-word']);
    expect(result.found).toBe(true);
    expect(result.strippedContent).toBe('fix it');
  });

  test('no match when neither global nor group words present', () => {
    const result = detectDevSafeWord('just a normal message', ['devmode']);
    expect(result.found).toBe(false);
  });
});

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
