import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock every dependency BEFORE importing index.ts ───────────────────────
// NOTE: vi.mock() calls are hoisted to the top of the file by Vitest.
// Factory functions cannot reference variables declared in the test file
// (they haven't been initialized yet). Use vi.fn() inline in factories.

// Config
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'TestBot',
  ASSISTANT_HAS_OWN_NUMBER: false,
  DEFAULT_TRIGGER: '@TestBot',
  getTriggerPattern: (trigger: string) => new RegExp(trigger, 'i'),
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  DATA_DIR: '/tmp/nanoclaw-test-data',
  IDLE_TIMEOUT: 1800000,
  MAX_MESSAGES_PER_PROMPT: 50,
  ONECLI_URL: 'http://localhost:10254',
  POLL_INTERVAL: 2000,
  SCHEDULER_POLL_INTERVAL: 60000,
  TIMEZONE: 'America/Los_Angeles',
  DAILY_BUDGET_USD: 50,
  MAX_CONCURRENT_CONTAINERS: 3,
  WARM_POOL_SIZE: 0,
}));

// Logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// DB
vi.mock('./db.js', () => ({
  getRouterState: vi.fn(),
  setRouterState: vi.fn(),
  deleteRouterState: vi.fn(),
  getPendingCursors: vi.fn(() => new Map()),
  getAllSessions: vi.fn(() => ({})),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getMessagesSince: vi.fn(() => []),
  getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
  getLastBotMessageTimestamp: vi.fn(() => null),
  initDatabase: vi.fn(),
  setRegisteredGroup: vi.fn(),
  setSession: vi.fn(),
  deleteSession: vi.fn(),
  logSessionCost: vi.fn(),
  getAllTasks: vi.fn(() => []),
  getAllChats: vi.fn(() => []),
  storeMessage: vi.fn(),
  storeChatMetadata: vi.fn(),
}));

// Channels
vi.mock('./channels/index.js', () => ({}));
vi.mock('./channels/registry.js', () => ({
  getChannelFactory: vi.fn(),
  getRegisteredChannelNames: vi.fn(() => []),
}));

// Container runner
vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

// Container runtime
vi.mock('./container-runtime.js', () => ({
  cleanupOrphans: vi.fn(),
  ensureContainerRuntimeRunning: vi.fn(),
}));

// Group queue
vi.mock('./group-queue.js', () => ({
  GroupQueue: class MockGroupQueue {
    setProcessMessagesFn = vi.fn();
    enqueueMessageCheck = vi.fn();
    enqueueTask = vi.fn();
    registerProcess = vi.fn();
    sendMessage = vi.fn().mockReturnValue(false);
    notifyIdle = vi.fn();
    closeStdin = vi.fn();
    shutdown = vi.fn().mockResolvedValue(undefined);
  },
}));

// Group folder
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/nanoclaw-test-groups/${folder}`,
  ),
  isValidGroupFolder: vi.fn().mockReturnValue(true),
}));

// Router
vi.mock('./router.js', () => ({
  findChannel: vi.fn(),
  formatMessages: vi.fn().mockReturnValue('formatted prompt'),
  formatOutbound: vi.fn((t: string) => t),
  escapeXml: vi.fn((t: string) => t),
}));

// IPC
vi.mock('./ipc.js', () => ({ startIpcWatcher: vi.fn() }));

// Remote control
vi.mock('./remote-control.js', () => ({
  restoreRemoteControl: vi.fn(),
  startRemoteControl: vi.fn(),
  stopRemoteControl: vi.fn(),
}));

// Sender allowlist
vi.mock('./sender-allowlist.js', () => ({
  isSenderAllowed: vi.fn().mockReturnValue(true),
  isTriggerAllowed: vi.fn().mockReturnValue(true),
  loadSenderAllowlist: vi.fn().mockReturnValue({}),
  shouldDropMessage: vi.fn().mockReturnValue(false),
}));

// Budget
vi.mock('./budget.js', () => ({
  isBudgetExceeded: vi.fn().mockReturnValue(false),
}));

// Learning — procedure match integration (returns false so normal flow runs)
vi.mock('./learning/index.js', () => ({
  initLearningSystem: vi.fn(),
  buildRulesBlock: vi.fn().mockReturnValue(null),
}));
vi.mock('./learning/procedure-match-integration.js', () => ({
  handleMessageWithProcedureCheck: vi.fn().mockResolvedValue(false),
}));

// LLM provider resolution
vi.mock('./llm/provider.js', () => ({
  resolveModel: vi.fn().mockReturnValue({
    provider: 'anthropic',
    model: null,
    providerBaseUrl: null,
  }),
}));

vi.mock('./llm/escalation.js', () => ({
  scoreComplexity: vi.fn().mockReturnValue({
    shouldEscalate: false,
    score: 0,
  }),
}));

// Other side-effect modules
vi.mock('./deal-watch-loop.js', () => ({ startDealWatchLoop: vi.fn() }));
vi.mock('./email-sse.js', () => ({ startEmailSSE: vi.fn() }));
vi.mock('./gmail-token-refresh.js', () => ({
  refreshGmailTokens: vi.fn(),
  startGmailRefreshLoop: vi.fn(),
}));
vi.mock('./task-scheduler.js', () => ({ startSchedulerLoop: vi.fn() }));

// OneCLI SDK — use a module-level array to capture ensureAgent calls.
// vi.mock factories are hoisted, so we use vi.hoisted() for shared state.
const { onecliCalls } = vi.hoisted(() => ({
  onecliCalls: [] as Array<{ name: string; identifier: string }>,
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = vi.fn((arg: { name: string; identifier: string }) => {
      onecliCalls.push(arg);
      return Promise.resolve({
        name: arg.name,
        identifier: arg.identifier,
        created: true,
      });
    });
  },
}));

// fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue(''),
      readdirSync: vi.fn().mockReturnValue([]),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// ─── Import the module under test + mocked deps AFTER mock declarations ──

import fs from 'fs';
import type { RegisteredGroup } from './types.js';
import type { ContainerOutput } from './container-runner.js';

import {
  _loadState,
  _registerGroup,
  _processGroupMessages,
  _runAgent,
  _setRegisteredGroups,
} from './index.js';

import {
  getRouterState,
  setRouterState,
  deleteRouterState,
  getPendingCursors,
  getAllSessions,
  getAllRegisteredGroups,
  getMessagesSince,
  setRegisteredGroup,
  logSessionCost,
  getAllTasks,
  getAllChats,
} from './db.js';

import { runContainerAgent } from './container-runner.js';
import { findChannel } from './router.js';
import { isBudgetExceeded } from './budget.js';
import { resolveGroupFolderPath } from './group-folder.js';

// Cast mocked imports to access vi.fn() methods
const mockGetRouterState = vi.mocked(getRouterState);
const mockSetRouterState = vi.mocked(setRouterState);
const mockDeleteRouterState = vi.mocked(deleteRouterState);
const mockGetPendingCursors = vi.mocked(getPendingCursors);
const mockGetAllSessions = vi.mocked(getAllSessions);
const mockGetAllRegisteredGroups = vi.mocked(getAllRegisteredGroups);
const mockGetMessagesSince = vi.mocked(getMessagesSince);
const mockSetRegisteredGroup = vi.mocked(setRegisteredGroup);
const mockLogSessionCost = vi.mocked(logSessionCost);
const mockGetAllTasks = vi.mocked(getAllTasks);
const mockGetAllChats = vi.mocked(getAllChats);
const mockRunContainerAgent = vi.mocked(runContainerAgent);
const mockFindChannel = vi.mocked(findChannel);
const mockIsBudgetExceeded = vi.mocked(isBudgetExceeded);
const mockResolveGroupFolderPath = vi.mocked(resolveGroupFolderPath);

// ─── Tests ──────────────────────────────────────────────────────────────

describe('index.ts — characterization tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onecliCalls.length = 0;
    _setRegisteredGroups({});
    // Reset default mock returns
    mockGetRouterState.mockReturnValue(undefined);
    mockGetPendingCursors.mockReturnValue(new Map());
    mockGetAllSessions.mockReturnValue({});
    mockGetAllRegisteredGroups.mockReturnValue({});
    mockGetMessagesSince.mockReturnValue([]);
    mockIsBudgetExceeded.mockReturnValue(false);
    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
    } as any);
    mockFindChannel.mockReturnValue(undefined);
    mockGetAllTasks.mockReturnValue([]);
    mockGetAllChats.mockReturnValue([]);
    mockResolveGroupFolderPath.mockImplementation(
      (folder: string) => `/tmp/nanoclaw-test-groups/${folder}`,
    );
  });

  // ─── 1. State loading ─────────────────────────────────────────────

  describe('loadState', () => {
    it('reads last_timestamp and sessions from DB', () => {
      mockGetRouterState.mockImplementation((key: string) => {
        if (key === 'last_timestamp') return '2024-01-01T00:00:00Z';
        if (key === 'last_agent_timestamp')
          return JSON.stringify({ 'group1@g.us': '2024-01-01T00:00:00Z' });
        return undefined;
      });
      mockGetAllSessions.mockReturnValue({ 'test-group': 'session-abc' });
      mockGetAllRegisteredGroups.mockReturnValue({
        'group1@g.us': {
          name: 'Test',
          folder: 'test-group',
          trigger: '@TestBot',
          added_at: '2024-01-01',
        },
      });

      _loadState();

      expect(mockGetRouterState).toHaveBeenCalledWith('last_timestamp');
      expect(mockGetRouterState).toHaveBeenCalledWith('last_agent_timestamp');
      expect(mockGetAllSessions).toHaveBeenCalled();
      expect(mockGetAllRegisteredGroups).toHaveBeenCalled();
    });

    it('recovers pending cursors by rolling back to previous value', () => {
      const pending = new Map([['group1@g.us', '2024-01-01T00:00:00Z']]);
      mockGetPendingCursors.mockReturnValue(pending);
      mockGetRouterState.mockImplementation((key: string) => {
        if (key === 'last_timestamp') return '';
        if (key === 'last_agent_timestamp')
          return JSON.stringify({ 'group1@g.us': '2024-01-01T01:00:00Z' });
        return undefined;
      });
      mockGetAllSessions.mockReturnValue({});
      mockGetAllRegisteredGroups.mockReturnValue({});

      _loadState();

      // Should delete the pending cursor from DB
      expect(mockDeleteRouterState).toHaveBeenCalledWith(
        'pending_cursor:group1@g.us',
      );
      // Should save the rolled-back cursor
      expect(mockSetRouterState).toHaveBeenCalledWith(
        'last_agent_timestamp',
        expect.stringContaining('2024-01-01T00:00:00Z'),
      );
    });

    it('handles corrupted last_agent_timestamp gracefully', () => {
      mockGetRouterState.mockImplementation((key: string) => {
        if (key === 'last_timestamp') return '';
        if (key === 'last_agent_timestamp') return '{invalid json';
        return undefined;
      });
      mockGetAllSessions.mockReturnValue({});
      mockGetAllRegisteredGroups.mockReturnValue({});

      expect(() => _loadState()).not.toThrow();
    });
  });

  // ─── 2. Group registration ────────────────────────────────────────

  describe('registerGroup', () => {
    it('creates group folder with logs directory', () => {
      const group: RegisteredGroup = {
        name: 'New Group',
        folder: 'new-group',
        trigger: '@TestBot',
        added_at: '2024-01-01',
      };

      _registerGroup('newgroup@g.us', group);

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        '/tmp/nanoclaw-test-groups/new-group/logs',
        { recursive: true },
      );
    });

    it('persists group to database', () => {
      const group: RegisteredGroup = {
        name: 'New Group',
        folder: 'new-group',
        trigger: '@TestBot',
        added_at: '2024-01-01',
      };

      _registerGroup('newgroup@g.us', group);

      expect(mockSetRegisteredGroup).toHaveBeenCalledWith(
        'newgroup@g.us',
        group,
      );
    });

    it('copies CLAUDE.md template for new groups', () => {
      const existsSyncMock = vi.mocked(fs.existsSync);
      const readFileSyncMock = vi.mocked(fs.readFileSync);
      existsSyncMock
        .mockReturnValueOnce(false) // groupMdFile doesn't exist
        .mockReturnValueOnce(true); // templateFile exists
      readFileSyncMock.mockReturnValue('# Andy\nYou are Andy' as any);

      const group: RegisteredGroup = {
        name: 'New Group',
        folder: 'new-group',
        trigger: '@TestBot',
        added_at: '2024-01-01',
      };

      _registerGroup('newgroup@g.us', group);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        '/tmp/nanoclaw-test-groups/new-group/CLAUDE.md',
        expect.any(String),
      );
    });

    it('ensures OneCLI agent for non-main groups', async () => {
      const group: RegisteredGroup = {
        name: 'Sales Team',
        folder: 'sales_team',
        trigger: '@TestBot',
        added_at: '2024-01-01',
      };

      _registerGroup('sales@g.us', group);

      // ensureAgent is fire-and-forget (no await in production code),
      // so flush the microtask queue to let the promise resolve.
      await vi.waitFor(() => {
        expect(onecliCalls).toHaveLength(1);
      });

      expect(onecliCalls[0]).toEqual({
        name: 'Sales Team',
        identifier: 'sales-team', // folder lowercased, underscores → hyphens
      });
    });

    it('skips OneCLI agent creation for main groups', async () => {
      const group: RegisteredGroup = {
        name: 'Main',
        folder: 'main',
        trigger: '@TestBot',
        added_at: '2024-01-01',
        isMain: true,
      };

      _registerGroup('main@g.us', group);

      // Give any fire-and-forget promises a chance to settle
      await new Promise((r) => setTimeout(r, 10));

      expect(onecliCalls).toHaveLength(0);
    });

    it('rejects registration with invalid folder path', () => {
      mockResolveGroupFolderPath.mockImplementationOnce(() => {
        throw new Error('path traversal');
      });

      const group: RegisteredGroup = {
        name: 'Bad Group',
        folder: '../escape',
        trigger: '@TestBot',
        added_at: '2024-01-01',
      };

      _registerGroup('bad@g.us', group);

      // Should NOT persist to DB
      expect(mockSetRegisteredGroup).not.toHaveBeenCalled();
    });
  });

  // ─── 3. Message processing flow ───────────────────────────────────

  describe('processGroupMessages', () => {
    const mockChannel = {
      name: 'test',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      setTyping: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockReturnValue(true),
      ownsJid: vi.fn().mockReturnValue(true),
      disconnect: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockResolvedValue(undefined),
    };

    beforeEach(() => {
      mockChannel.sendMessage.mockClear();
      mockChannel.setTyping.mockClear();
    });

    it('returns true (success) when no messages are pending', async () => {
      _setRegisteredGroups({
        'group1@g.us': {
          name: 'Test',
          folder: 'test-group',
          trigger: '@TestBot',
          added_at: '2024-01-01',
        },
      });
      mockFindChannel.mockReturnValue(mockChannel);
      mockGetMessagesSince.mockReturnValue([]);

      const result = await _processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockRunContainerAgent).not.toHaveBeenCalled();
    });

    it('returns true when group is not registered', async () => {
      _setRegisteredGroups({});

      const result = await _processGroupMessages('unknown@g.us');

      expect(result).toBe(true);
    });

    it('skips non-main groups when trigger is absent', async () => {
      _setRegisteredGroups({
        'group1@g.us': {
          name: 'Test',
          folder: 'test-group',
          trigger: '@TestBot',
          added_at: '2024-01-01',
          requiresTrigger: true,
        },
      });
      mockFindChannel.mockReturnValue(mockChannel);
      mockGetMessagesSince.mockReturnValue([
        {
          id: 'msg1',
          chat_jid: 'group1@g.us',
          sender: 'user1',
          sender_name: 'User',
          content: 'Hello everyone',
          timestamp: '2024-01-01T01:00:00Z',
        },
      ]);

      const result = await _processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockRunContainerAgent).not.toHaveBeenCalled();
    });

    it('processes messages when trigger is present in non-main group', async () => {
      _setRegisteredGroups({
        'group1@g.us': {
          name: 'Test',
          folder: 'test-group',
          trigger: '@TestBot',
          added_at: '2024-01-01',
          requiresTrigger: true,
        },
      });
      mockFindChannel.mockReturnValue(mockChannel);
      mockGetMessagesSince.mockReturnValue([
        {
          id: 'msg1',
          chat_jid: 'group1@g.us',
          sender: 'user1',
          sender_name: 'User',
          content: '@TestBot help me',
          timestamp: '2024-01-01T01:00:00Z',
          is_from_me: true,
        },
      ]);
      mockRunContainerAgent.mockImplementation((async (
        _group: any,
        _input: any,
        _onProcess: any,
        onOutput: (o: any) => Promise<void>,
      ) => {
        await onOutput({
          status: 'success',
          result: 'Here is help',
          newSessionId: 'sess-1',
        });
        return { status: 'success', newSessionId: 'sess-1' };
      }) as any);

      const result = await _processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockRunContainerAgent).toHaveBeenCalled();
    });

    it('rolls back cursor on error when no output was sent', async () => {
      _setRegisteredGroups({
        'group1@g.us': {
          name: 'Test',
          folder: 'test-group',
          trigger: '@TestBot',
          added_at: '2024-01-01',
          isMain: true,
        },
      });
      mockFindChannel.mockReturnValue(mockChannel);
      mockGetMessagesSince.mockReturnValue([
        {
          id: 'msg1',
          chat_jid: 'group1@g.us',
          sender: 'user1',
          sender_name: 'User',
          content: 'do something',
          timestamp: '2024-01-01T02:00:00Z',
        },
      ]);
      mockRunContainerAgent.mockImplementation((async (
        _group: any,
        _input: any,
        _onProcess: any,
        onOutput: (o: any) => Promise<void>,
      ) => {
        await onOutput({ status: 'error', error: 'container crashed' });
        return { status: 'error', error: 'container crashed' };
      }) as any);

      const result = await _processGroupMessages('group1@g.us');

      expect(result).toBe(false);
      // Cursor rolled back — setRouterState called with the old (empty) value
      expect(mockSetRouterState).toHaveBeenCalledWith(
        'last_agent_timestamp',
        expect.any(String),
      );
      expect(mockDeleteRouterState).toHaveBeenCalledWith(
        'pending_cursor:group1@g.us',
      );
    });

    it('does NOT roll back cursor when output was already sent to user', async () => {
      _setRegisteredGroups({
        'group1@g.us': {
          name: 'Test',
          folder: 'test-group',
          trigger: '@TestBot',
          added_at: '2024-01-01',
          isMain: true,
        },
      });
      mockFindChannel.mockReturnValue(mockChannel);
      mockGetMessagesSince.mockReturnValue([
        {
          id: 'msg1',
          chat_jid: 'group1@g.us',
          sender: 'user1',
          sender_name: 'User',
          content: 'do something',
          timestamp: '2024-01-01T02:00:00Z',
        },
      ]);
      mockRunContainerAgent.mockImplementation((async (
        _group: any,
        _input: any,
        _onProcess: any,
        onOutput: (o: any) => Promise<void>,
      ) => {
        // First: successful output (gets sent to user)
        await onOutput({
          status: 'success',
          result: 'Here is a partial response',
        });
        // Then: error
        await onOutput({ status: 'error', error: 'timeout' });
        return { status: 'error', error: 'timeout' };
      }) as any);

      const result = await _processGroupMessages('group1@g.us');

      // Should return true to prevent duplicate messages on retry
      expect(result).toBe(true);
      expect(mockDeleteRouterState).toHaveBeenCalledWith(
        'pending_cursor:group1@g.us',
      );
    });
  });

  // ─── 4. Budget check ──────────────────────────────────────────────

  describe('runAgent budget gate', () => {
    it('blocks execution when budget is exceeded', async () => {
      mockIsBudgetExceeded.mockReturnValue(true);

      const group: RegisteredGroup = {
        name: 'Test',
        folder: 'test-group',
        trigger: '@TestBot',
        added_at: '2024-01-01',
      };

      const result = await _runAgent(group, 'test prompt', 'group1@g.us');

      expect(result).toBe('error');
      expect(mockRunContainerAgent).not.toHaveBeenCalled();
    });

    it('allows execution when under budget', async () => {
      mockIsBudgetExceeded.mockReturnValue(false);
      mockRunContainerAgent.mockResolvedValue({
        status: 'success',
        result: 'test response',
        newSessionId: 'sess-1',
      });

      const group: RegisteredGroup = {
        name: 'Test',
        folder: 'test-group',
        trigger: '@TestBot',
        added_at: '2024-01-01',
      };

      const result = await _runAgent(group, 'test prompt', 'group1@g.us');

      expect(result).toBe('success');
      expect(mockRunContainerAgent).toHaveBeenCalled();
      expect(mockLogSessionCost).toHaveBeenCalled();
    });

    it('returns error and logs cost when container agent fails', async () => {
      mockIsBudgetExceeded.mockReturnValue(false);
      mockRunContainerAgent.mockResolvedValue({
        status: 'error',
        result: null,
        error: 'OOM killed',
      });

      const group: RegisteredGroup = {
        name: 'Test',
        folder: 'test-group',
        trigger: '@TestBot',
        added_at: '2024-01-01',
      };

      const result = await _runAgent(group, 'test prompt', 'group1@g.us');

      expect(result).toBe('error');
      expect(mockLogSessionCost).toHaveBeenCalledWith(
        expect.objectContaining({
          session_type: 'message',
          group_folder: 'test-group',
        }),
      );
    });

    it('returns error when container agent throws', async () => {
      mockIsBudgetExceeded.mockReturnValue(false);
      mockRunContainerAgent.mockRejectedValue(new Error('spawn failed'));

      const group: RegisteredGroup = {
        name: 'Test',
        folder: 'test-group',
        trigger: '@TestBot',
        added_at: '2024-01-01',
      };

      const result = await _runAgent(group, 'test prompt', 'group1@g.us');

      expect(result).toBe('error');
      expect(mockLogSessionCost).toHaveBeenCalled();
    });
  });
});
