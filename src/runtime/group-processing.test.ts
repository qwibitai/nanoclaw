import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import type { Channel, NewMessage, RegisteredGroup } from '../core/types.js';
import type { AgentOutput } from './agent-spawn-types.js';
import type { GroupProcessingDeps } from './group-processing.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../core/config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  IDLE_TIMEOUT: 1_800_000,
  MAX_MESSAGES_PER_PROMPT: 50,
  TIMEZONE: 'UTC',
  getDefaultModelConfig: () => ({ model: undefined }),
  getTriggerPattern: (trigger?: string) =>
    trigger ? new RegExp(`^@${trigger}\\b`, 'i') : /^@Andy\b/i,
}));

vi.mock('../core/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockWriteMemoryContextSnapshot = vi.fn();
vi.mock('../memory/memory-ipc.js', () => ({
  writeMemoryContextSnapshot: (...args: unknown[]) =>
    mockWriteMemoryContextSnapshot(...args),
}));

const mockReflectAfterTurn = vi.fn();
vi.mock('../memory/memory-service.js', () => ({
  MemoryService: {
    getInstance: () => ({
      reflectAfterTurn: (...args: unknown[]) => mockReflectAfterTurn(...args),
    }),
  },
}));

const mockFindChannel = vi.fn();
const mockFormatMessages = vi.fn();
vi.mock('../messaging/router.js', () => ({
  findChannel: (...args: unknown[]) => mockFindChannel(...args),
  formatMessages: (...args: unknown[]) => mockFormatMessages(...args),
}));

const mockIsTriggerAllowed = vi.fn();
const mockLoadSenderAllowlist = vi.fn();
vi.mock('../platform/sender-allowlist.js', () => ({
  isTriggerAllowed: (...args: unknown[]) => mockIsTriggerAllowed(...args),
  loadSenderAllowlist: (...args: unknown[]) => mockLoadSenderAllowlist(...args),
}));

const mockDeleteSession = vi.fn();
const mockGetAllJobs = vi.fn();
const mockGetMessagesSince = vi.fn();
const mockGetRecentJobRuns = vi.fn();
vi.mock('../storage/db.js', () => ({
  deleteSession: (...args: unknown[]) => mockDeleteSession(...args),
  getAllJobs: (...args: unknown[]) => mockGetAllJobs(...args),
  getMessagesSince: (...args: unknown[]) => mockGetMessagesSince(...args),
  getRecentJobRuns: (...args: unknown[]) => mockGetRecentJobRuns(...args),
}));

const mockSpawnAgent = vi.fn();
const mockWriteJobRunsSnapshot = vi.fn();
const mockWriteJobsSnapshot = vi.fn();
const mockWriteGroupsSnapshot = vi.fn();
vi.mock('./agent-spawn.js', () => ({
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  writeJobRunsSnapshot: (...args: unknown[]) =>
    mockWriteJobRunsSnapshot(...args),
  writeJobsSnapshot: (...args: unknown[]) => mockWriteJobsSnapshot(...args),
  writeGroupsSnapshot: (...args: unknown[]) =>
    mockWriteGroupsSnapshot(...args),
}));

const mockArchiveSessionTranscript = vi.fn();
vi.mock('../session/session-transcript-archive.js', () => ({
  archiveSessionTranscript: (...args: unknown[]) =>
    mockArchiveSessionTranscript(...args),
}));

const mockHandleSessionCommand = vi.fn();
vi.mock('../session/session-commands.js', () => ({
  handleSessionCommand: (...args: unknown[]) =>
    mockHandleSessionCommand(...args),
}));

const mockCollectRuntimeDiagnostics = vi.fn();
const mockFormatRuntimeDiagnosticsMessage = vi.fn();
vi.mock('./runtime-diagnostics.js', () => ({
  collectRuntimeDiagnostics: (...args: unknown[]) =>
    mockCollectRuntimeDiagnostics(...args),
  formatRuntimeDiagnosticsMessage: (...args: unknown[]) =>
    mockFormatRuntimeDiagnosticsMessage(...args),
}));

// ---------------------------------------------------------------------------
// Import the module under test AFTER all mocks are declared
// ---------------------------------------------------------------------------

const { createGroupProcessor } = await import('./group-processing.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  overrides: Partial<NewMessage> = {},
): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group1@g.us',
    sender: 'user1@s.whatsapp.net',
    sender_name: 'User1',
    content: 'hello',
    timestamp: '1700000001',
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'TestGroup',
    folder: 'test-group',
    trigger: 'Andy',
    added_at: '2024-01-01',
    requiresTrigger: true,
    isMain: false,
    ...overrides,
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: 'test-channel',
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    ownsJid: vi.fn().mockReturnValue(true),
    disconnect: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<GroupProcessingDeps> = {}): GroupProcessingDeps {
  return {
    channels: [],
    getGroup: vi.fn().mockReturnValue(undefined),
    getSession: vi.fn().mockReturnValue(undefined),
    setSession: vi.fn(),
    clearSession: vi.fn(),
    getCursor: vi.fn().mockReturnValue('0'),
    setCursor: vi.fn(),
    saveState: vi.fn(),
    setGroupModelOverride: vi.fn(),
    setGroupThinkingOverride: vi.fn(),
    getAvailableGroups: vi.fn().mockReturnValue([]),
    getRegisteredJids: vi.fn().mockReturnValue(new Set<string>()),
    queue: {
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
      registerProcess: vi.fn(),
    },
    ...overrides,
  };
}

/**
 * Configure a standard "happy path" set of mocks that processes messages
 * through to agent spawn. Returns the deps and channel for further assertions.
 */
function setupHappyPath(opts: {
  group?: RegisteredGroup;
  messages?: NewMessage[];
  agentOutput?: AgentOutput;
} = {}) {
  const group = opts.group ?? makeGroup({ isMain: true });
  const channel = makeChannel();
  const messages = opts.messages ?? [makeMessage()];
  const agentOutput: AgentOutput = opts.agentOutput ?? {
    status: 'success',
    result: 'Agent reply text',
  };

  const deps = makeDeps({
    channels: [channel],
    getGroup: vi.fn().mockReturnValue(group),
  });

  mockFindChannel.mockReturnValue(channel);
  mockGetMessagesSince.mockReturnValue(messages);
  mockHandleSessionCommand.mockResolvedValue({ handled: false });
  mockFormatMessages.mockReturnValue('formatted prompt');
  mockGetAllJobs.mockReturnValue([]);
  mockGetRecentJobRuns.mockReturnValue([]);
  mockWriteMemoryContextSnapshot.mockResolvedValue({ retrievedItemIds: [] });
  mockReflectAfterTurn.mockResolvedValue(undefined);
  mockLoadSenderAllowlist.mockReturnValue({});
  mockIsTriggerAllowed.mockReturnValue(true);

  // spawnAgent: by default calls onOutput with a successful result then returns it
  mockSpawnAgent.mockImplementation(
    async (
      _group: RegisteredGroup,
      _input: unknown,
      _onProc: unknown,
      onOutput?: (output: AgentOutput) => Promise<void>,
    ) => {
      if (onOutput) await onOutput(agentOutput);
      return agentOutput;
    },
  );

  return { deps, channel, group, messages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createGroupProcessor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =======================================================================
  // Early returns
  // =======================================================================

  describe('early returns', () => {
    it('returns true when group is not found', async () => {
      const deps = makeDeps({ getGroup: vi.fn().mockReturnValue(undefined) });
      const { processGroupMessages } = createGroupProcessor(deps);

      const result = await processGroupMessages('unknown@g.us');

      expect(result).toBe(true);
      expect(mockFindChannel).not.toHaveBeenCalled();
    });

    it('returns true when channel is not found for the JID', async () => {
      const group = makeGroup();
      const deps = makeDeps({
        getGroup: vi.fn().mockReturnValue(group),
      });
      mockFindChannel.mockReturnValue(undefined);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
    });

    it('returns true when there are no missed messages', async () => {
      const channel = makeChannel();
      const group = makeGroup();
      const deps = makeDeps({
        channels: [channel],
        getGroup: vi.fn().mockReturnValue(group),
      });
      mockFindChannel.mockReturnValue(channel);
      mockGetMessagesSince.mockReturnValue([]);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Session command delegation
  // =======================================================================

  describe('session command handling', () => {
    it('delegates to handleSessionCommand and returns success when handled', async () => {
      const { deps } = setupHappyPath();
      mockHandleSessionCommand.mockResolvedValue({ handled: true, success: true });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    it('delegates to handleSessionCommand and returns false when handled but failed', async () => {
      const { deps } = setupHappyPath();
      mockHandleSessionCommand.mockResolvedValue({ handled: true, success: false });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(false);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    it('continues processing when session command is not handled', async () => {
      const { deps } = setupHappyPath();
      mockHandleSessionCommand.mockResolvedValue({ handled: false });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Trigger pattern gating for non-main groups
  // =======================================================================

  describe('trigger pattern filtering (non-main groups)', () => {
    it('returns true without processing when non-main group has no trigger in messages', async () => {
      const group = makeGroup({ isMain: false, requiresTrigger: true, trigger: 'Andy' });
      const messages = [makeMessage({ content: 'hello there' })];
      const { deps } = setupHappyPath({ group, messages });
      mockIsTriggerAllowed.mockReturnValue(true);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });

    it('processes messages when non-main group has trigger in messages', async () => {
      const group = makeGroup({ isMain: false, requiresTrigger: true, trigger: 'Andy' });
      const messages = [makeMessage({ content: '@Andy please help' })];
      const { deps } = setupHappyPath({ group, messages });
      mockIsTriggerAllowed.mockReturnValue(true);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).toHaveBeenCalled();
    });

    it('skips trigger check for main groups', async () => {
      const group = makeGroup({ isMain: true, requiresTrigger: true });
      const messages = [makeMessage({ content: 'no trigger here' })];
      const { deps } = setupHappyPath({ group, messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).toHaveBeenCalled();
    });

    it('skips trigger check when requiresTrigger is false', async () => {
      const group = makeGroup({ isMain: false, requiresTrigger: false });
      const messages = [makeMessage({ content: 'no trigger here' })];
      const { deps } = setupHappyPath({ group, messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).toHaveBeenCalled();
    });

    it('allows trigger from own messages (is_from_me)', async () => {
      const group = makeGroup({ isMain: false, requiresTrigger: true, trigger: 'Andy' });
      const messages = [
        makeMessage({ content: '@Andy do this', is_from_me: true }),
      ];
      const { deps } = setupHappyPath({ group, messages });
      // isTriggerAllowed does NOT need to pass for is_from_me messages
      mockIsTriggerAllowed.mockReturnValue(false);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).toHaveBeenCalled();
    });

    it('blocks trigger from non-allowlisted sender', async () => {
      const group = makeGroup({ isMain: false, requiresTrigger: true, trigger: 'Andy' });
      const messages = [
        makeMessage({ content: '@Andy do this', is_from_me: false }),
      ];
      const { deps } = setupHappyPath({ group, messages });
      mockIsTriggerAllowed.mockReturnValue(false);

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      expect(mockSpawnAgent).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Successful agent run
  // =======================================================================

  describe('successful agent run', () => {
    it('advances cursor to last message timestamp', async () => {
      const messages = [
        makeMessage({ timestamp: '1700000001' }),
        makeMessage({ timestamp: '1700000005', id: 'msg-2' }),
      ];
      const { deps } = setupHappyPath({ messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // Cursor set to last message timestamp
      expect(deps.setCursor).toHaveBeenCalledWith('group1@g.us', '1700000005');
      expect(deps.saveState).toHaveBeenCalled();
    });

    it('calls memory reflectAfterTurn on success', async () => {
      const { deps } = setupHappyPath();

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockReflectAfterTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          groupFolder: 'test-group',
          prompt: 'formatted prompt',
        }),
      );
    });

    it('returns true on successful agent run', async () => {
      const { deps } = setupHappyPath();

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
    });

    it('sends agent output to channel with internal tags stripped', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: 'Hello <internal>secret stuff</internal> world',
      };
      const { deps, channel } = setupHappyPath({ agentOutput });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'Hello  world',
      );
    });

    it('does not send empty messages after stripping internal tags', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: '<internal>all internal</internal>',
      };
      const { deps, channel } = setupHappyPath({ agentOutput });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).not.toHaveBeenCalled();
    });

    it('calls setTyping true before and false after agent run', async () => {
      const { deps, channel } = setupHappyPath();

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      const typingCalls = (channel.setTyping as ReturnType<typeof vi.fn>).mock.calls;
      expect(typingCalls[0]).toEqual(['group1@g.us', true]);
      expect(typingCalls[typingCalls.length - 1]).toEqual(['group1@g.us', false]);
    });

    it('notifies idle on success status from onOutput callback', async () => {
      const { deps } = setupHappyPath();

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.queue.notifyIdle).toHaveBeenCalledWith('group1@g.us');
    });

    it('writes job and group snapshots via runAgent', async () => {
      const { deps } = setupHappyPath();
      mockGetAllJobs.mockReturnValue([]);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockWriteJobsSnapshot).toHaveBeenCalled();
      expect(mockWriteJobRunsSnapshot).toHaveBeenCalled();
      expect(mockWriteGroupsSnapshot).toHaveBeenCalled();
    });

    it('collects memoryUserId from last non-bot non-self message', async () => {
      const messages = [
        makeMessage({
          sender: 'bot@s.whatsapp.net',
          is_bot_message: true,
          timestamp: '1700000001',
        }),
        makeMessage({
          sender: 'user2@s.whatsapp.net',
          is_from_me: false,
          is_bot_message: false,
          timestamp: '1700000002',
          id: 'msg-2',
        }),
        makeMessage({
          sender: 'self@s.whatsapp.net',
          is_from_me: true,
          timestamp: '1700000003',
          id: 'msg-3',
        }),
      ];
      const { deps } = setupHappyPath({ messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // reflectAfterTurn should receive the userId from the last non-self, non-bot message
      // Iterating in reverse: msg-3 is is_from_me (skip), msg-2 qualifies
      expect(mockReflectAfterTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user2@s.whatsapp.net',
        }),
      );
    });
  });

  // =======================================================================
  // Agent error scenarios
  // =======================================================================

  describe('agent error with no output sent', () => {
    it('rolls back cursor and returns false', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const { deps } = setupHappyPath({ group, messages });

      // Return error with NO result (no output sent to user)
      const errorOutput: AgentOutput = { status: 'error', result: null, error: 'boom' };
      mockSpawnAgent.mockImplementation(
        async (
          _group: RegisteredGroup,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) await onOutput(errorOutput);
          return errorOutput;
        },
      );

      (deps.getCursor as ReturnType<typeof vi.fn>).mockReturnValue('prev-cursor');

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(false);
      // cursor should be rolled back to the previous value
      const setCursorCalls = (deps.setCursor as ReturnType<typeof vi.fn>).mock.calls;
      const lastSetCursor = setCursorCalls[setCursorCalls.length - 1];
      expect(lastSetCursor).toEqual(['group1@g.us', 'prev-cursor']);
    });

    it('does not call memory reflection on error', async () => {
      const { deps } = setupHappyPath();

      const errorOutput: AgentOutput = { status: 'error', result: null, error: 'boom' };
      mockSpawnAgent.mockImplementation(
        async (
          _group: RegisteredGroup,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) await onOutput(errorOutput);
          return errorOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockReflectAfterTurn).not.toHaveBeenCalled();
    });
  });

  describe('agent error AFTER output was sent to user', () => {
    it('does NOT roll back cursor and returns true (prevents duplicates)', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const { deps, channel } = setupHappyPath({ group, messages });

      // Simulate: first call has result text, second call signals error
      mockSpawnAgent.mockImplementation(
        async (
          _group: RegisteredGroup,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          // First output chunk with actual text (will trigger sendMessage)
          if (onOutput) {
            await onOutput({ status: 'success', result: 'Partial response' });
          }
          // Then signal error
          if (onOutput) {
            await onOutput({ status: 'error', result: null, error: 'late error' });
          }
          return { status: 'error', result: null, error: 'late error' } as AgentOutput;
        },
      );

      (deps.getCursor as ReturnType<typeof vi.fn>).mockReturnValue('prev-cursor');

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
      // Output was sent
      expect(channel.sendMessage).toHaveBeenCalledWith('group1@g.us', 'Partial response');

      // Cursor should NOT be rolled back: the last setCursor should be the advance, not a rollback
      const setCursorCalls = (deps.setCursor as ReturnType<typeof vi.fn>).mock.calls;
      // First call advances cursor to message timestamp; there should be no second rollback call
      expect(setCursorCalls).toHaveLength(1);
      expect(setCursorCalls[0]).toEqual(['group1@g.us', '1700000001']);
    });
  });

  describe('agent spawn throws exception', () => {
    it('rolls back cursor and returns false when spawnAgent throws', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage({ timestamp: '1700000001' })];
      const { deps } = setupHappyPath({ group, messages });

      mockSpawnAgent.mockRejectedValue(new Error('spawn failed'));
      (deps.getCursor as ReturnType<typeof vi.fn>).mockReturnValue('prev-cursor');

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      // runAgent catches the error and returns 'error', no output was sent
      expect(result).toBe(false);
    });
  });

  // =======================================================================
  // Stale session detection
  // =======================================================================

  describe('stale session detection', () => {
    it('clears session when error matches stale-session pattern', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage()];
      const { deps } = setupHappyPath({ group, messages });

      // Return existing session
      (deps.getSession as ReturnType<typeof vi.fn>).mockReturnValue('old-session-id');

      const errorOutput: AgentOutput = {
        status: 'error',
        result: null,
        error: 'no conversation found for session abc123',
      };
      mockSpawnAgent.mockImplementation(
        async (
          _group: RegisteredGroup,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) await onOutput(errorOutput);
          return errorOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.clearSession).toHaveBeenCalledWith('test-group');
      expect(mockArchiveSessionTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          groupFolder: 'test-group',
          sessionId: 'old-session-id',
          cause: 'stale-session',
        }),
      );
    });

    it('clears session on ENOENT .jsonl error pattern', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage()];
      const { deps } = setupHappyPath({ group, messages });
      (deps.getSession as ReturnType<typeof vi.fn>).mockReturnValue('sess-1');

      const errorOutput: AgentOutput = {
        status: 'error',
        result: null,
        error: 'ENOENT: no such file /tmp/session.jsonl',
      };
      mockSpawnAgent.mockImplementation(
        async (
          _group: RegisteredGroup,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) await onOutput(errorOutput);
          return errorOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.clearSession).toHaveBeenCalledWith('test-group');
    });

    it('clears session on session not found error pattern', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage()];
      const { deps } = setupHappyPath({ group, messages });
      (deps.getSession as ReturnType<typeof vi.fn>).mockReturnValue('sess-2');

      const errorOutput: AgentOutput = {
        status: 'error',
        result: null,
        error: 'session xyz not found',
      };
      mockSpawnAgent.mockImplementation(
        async (
          _group: RegisteredGroup,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) await onOutput(errorOutput);
          return errorOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.clearSession).toHaveBeenCalledWith('test-group');
    });

    it('does NOT clear session when error is unrelated', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage()];
      const { deps } = setupHappyPath({ group, messages });
      (deps.getSession as ReturnType<typeof vi.fn>).mockReturnValue('sess-3');

      const errorOutput: AgentOutput = {
        status: 'error',
        result: null,
        error: 'timeout waiting for response',
      };
      mockSpawnAgent.mockImplementation(
        async (
          _group: RegisteredGroup,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) await onOutput(errorOutput);
          return errorOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.clearSession).not.toHaveBeenCalled();
      expect(mockArchiveSessionTranscript).not.toHaveBeenCalled();
    });

    it('does NOT clear session when there is no existing session', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage()];
      const { deps } = setupHappyPath({ group, messages });
      (deps.getSession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      const errorOutput: AgentOutput = {
        status: 'error',
        result: null,
        error: 'no conversation found',
      };
      mockSpawnAgent.mockImplementation(
        async (
          _group: RegisteredGroup,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) await onOutput(errorOutput);
          return errorOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // No session to clear — staleSessionId is empty string which is falsy
      expect(deps.clearSession).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Memory context snapshot failure (graceful)
  // =======================================================================

  describe('memory context snapshot failure', () => {
    it('continues processing when writeMemoryContextSnapshot fails', async () => {
      const { deps } = setupHappyPath();
      mockWriteMemoryContextSnapshot.mockRejectedValue(
        new Error('memory snapshot boom'),
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      // Should still succeed — memory failure is non-fatal
      expect(result).toBe(true);
      expect(mockSpawnAgent).toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Memory reflection failure (graceful)
  // =======================================================================

  describe('memory reflection failure after successful turn', () => {
    it('returns true even when reflectAfterTurn throws', async () => {
      const { deps } = setupHappyPath();
      mockReflectAfterTurn.mockRejectedValue(new Error('reflection boom'));

      const { processGroupMessages } = createGroupProcessor(deps);
      const result = await processGroupMessages('group1@g.us');

      expect(result).toBe(true);
    });
  });

  // =======================================================================
  // newSessionId propagation
  // =======================================================================

  describe('session ID propagation', () => {
    it('sets new session ID from agent output', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: 'response',
        newSessionId: 'new-sess-123',
      };
      const group = makeGroup({ isMain: true });
      const { deps } = setupHappyPath({ group, agentOutput });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.setSession).toHaveBeenCalledWith('test-group', 'new-sess-123');
    });

    it('sets session ID from onOutput callback when newSessionId present', async () => {
      const group = makeGroup({ isMain: true });
      const { deps } = setupHappyPath({ group });

      mockSpawnAgent.mockImplementation(
        async (
          _group: RegisteredGroup,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) {
            await onOutput({
              status: 'success',
              result: 'text',
              newSessionId: 'streamed-sess',
            });
          }
          return { status: 'success', result: 'text' } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.setSession).toHaveBeenCalledWith('test-group', 'streamed-sess');
    });
  });

  // =======================================================================
  // Idle timeout behavior
  // =======================================================================

  describe('idle timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('closes stdin after IDLE_TIMEOUT ms when agent produces output', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage()];
      const { deps } = setupHappyPath({ group, messages });

      // Make spawnAgent call onOutput then wait, so the idle timer can fire
      mockSpawnAgent.mockImplementation(
        async (
          _group: RegisteredGroup,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) {
            await onOutput({ status: 'success', result: 'hello' });
          }
          // Simulate agent waiting (idle timeout should fire during this)
          await vi.advanceTimersByTimeAsync(1_800_000);
          return { status: 'success', result: 'hello' } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.queue.closeStdin).toHaveBeenCalledWith('group1@g.us');
    });

    it('clears idle timer after agent completes', async () => {
      const group = makeGroup({ isMain: true });
      const messages = [makeMessage()];
      const { deps } = setupHappyPath({ group, messages });

      const agentOutput: AgentOutput = { status: 'success', result: 'fast reply' };
      mockSpawnAgent.mockImplementation(
        async (
          _group: RegisteredGroup,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          if (onOutput) await onOutput(agentOutput);
          return agentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // Now advance timers well past IDLE_TIMEOUT — closeStdin should NOT be called
      // because the timer was cleared after the agent finished
      (deps.queue.closeStdin as ReturnType<typeof vi.fn>).mockClear();
      await vi.advanceTimersByTimeAsync(2_000_000);

      expect(deps.queue.closeStdin).not.toHaveBeenCalled();
    });
  });

  // =======================================================================
  // Output result handling details
  // =======================================================================

  describe('output handling', () => {
    it('handles non-string result by JSON.stringifying', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: JSON.stringify({ key: 'value' }),
      };
      const { deps, channel } = setupHappyPath({ agentOutput });

      // Override: spawnAgent returns object-like result that is already a string
      // The source does typeof result === 'string' check

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        '{"key":"value"}',
      );
    });

    it('does not call sendMessage when result is null', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result: null,
      };
      const { deps, channel } = setupHappyPath({ agentOutput });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).not.toHaveBeenCalled();
    });

    it('strips multiple internal tags from output', async () => {
      const agentOutput: AgentOutput = {
        status: 'success',
        result:
          'Start <internal>tag1</internal> middle <internal>tag2\nmultiline</internal> end',
      };
      const { deps, channel } = setupHappyPath({ agentOutput });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(channel.sendMessage).toHaveBeenCalledWith(
        'group1@g.us',
        'Start  middle  end',
      );
    });
  });

  // =======================================================================
  // Integration: cursor management end-to-end
  // =======================================================================

  describe('cursor management', () => {
    it('uses cursor from deps.getCursor when calling getMessagesSince', async () => {
      const group = makeGroup({ isMain: true });
      const channel = makeChannel();
      const deps = makeDeps({
        channels: [channel],
        getGroup: vi.fn().mockReturnValue(group),
        getCursor: vi.fn().mockReturnValue('cursor-ts-123'),
      });

      mockFindChannel.mockReturnValue(channel);
      mockGetMessagesSince.mockReturnValue([]);

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockGetMessagesSince).toHaveBeenCalledWith(
        'group1@g.us',
        'cursor-ts-123',
        'Andy',
        50,
      );
    });

    it('saves state after advancing cursor', async () => {
      const messages = [makeMessage({ timestamp: '1700000099' })];
      const { deps } = setupHappyPath({ messages });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // setCursor should be called before saveState
      const setCursorOrder = (deps.setCursor as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      const saveStateOrder = (deps.saveState as ReturnType<typeof vi.fn>).mock
        .invocationCallOrder[0];
      expect(setCursorOrder).toBeLessThan(saveStateOrder);
    });
  });

  // =======================================================================
  // onProcess callback passed to spawnAgent
  // =======================================================================

  describe('process registration', () => {
    it('passes registerProcess callback to spawnAgent', async () => {
      const group = makeGroup({ isMain: true });
      const { deps } = setupHappyPath({ group });

      const mockProc = {} as ChildProcess;
      mockSpawnAgent.mockImplementation(
        async (
          _group: RegisteredGroup,
          _input: unknown,
          onProc: (proc: ChildProcess, containerName: string) => void,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          onProc(mockProc, 'test-container');
          if (onOutput) {
            await onOutput({ status: 'success', result: 'ok' });
          }
          return { status: 'success', result: 'ok' } as AgentOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(deps.queue.registerProcess).toHaveBeenCalledWith(
        'group1@g.us',
        mockProc,
        'test-container',
        'test-group',
      );
    });
  });

  // =======================================================================
  // retrievedItemIds flow
  // =======================================================================

  describe('retrievedItemIds pass-through', () => {
    it('passes retrieved item IDs from memory snapshot to reflectAfterTurn', async () => {
      const { deps } = setupHappyPath();
      mockWriteMemoryContextSnapshot.mockResolvedValue({
        retrievedItemIds: ['item-a', 'item-b'],
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockReflectAfterTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          retrievedItemIds: ['item-a', 'item-b'],
        }),
      );
    });

    it('passes empty retrievedItemIds when memory snapshot fails', async () => {
      const { deps } = setupHappyPath();
      mockWriteMemoryContextSnapshot.mockRejectedValue(new Error('fail'));

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockReflectAfterTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          retrievedItemIds: [],
        }),
      );
    });
  });

  // =======================================================================
  // Agent input construction
  // =======================================================================

  describe('agent input construction', () => {
    it('passes correct input fields to spawnAgent', async () => {
      const group = makeGroup({
        isMain: true,
        folder: 'my-group',
        agentConfig: { thinking: { mode: 'adaptive' } },
      });
      const { deps } = setupHappyPath({ group });
      (deps.getSession as ReturnType<typeof vi.fn>).mockReturnValue('sess-xyz');

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      expect(mockSpawnAgent).toHaveBeenCalledWith(
        group,
        expect.objectContaining({
          prompt: 'formatted prompt',
          sessionId: 'sess-xyz',
          groupFolder: 'my-group',
          chatJid: 'group1@g.us',
          isMain: true,
          assistantName: 'Andy',
          thinking: { mode: 'adaptive' },
        }),
        expect.any(Function), // onProcess
        expect.any(Function), // onOutput
        undefined, // options
      );
    });
  });

  // =======================================================================
  // handleSessionCommand deps (closure) coverage
  // =======================================================================

  describe('handleSessionCommand deps closures', () => {
    /**
     * Helper: calls processGroupMessages with a mock handleSessionCommand that
     * captures the `deps` object it receives, then returns { handled: true, success: true }.
     * Returns the captured deps for the test to exercise individual closures.
     */
    async function captureSessionDeps(opts: {
      group?: RegisteredGroup;
      messages?: NewMessage[];
    } = {}) {
      const group = opts.group ?? makeGroup({ isMain: true, folder: 'grp-folder' });
      const channel = makeChannel();
      const messages = opts.messages ?? [makeMessage()];

      const deps = makeDeps({
        channels: [channel],
        getGroup: vi.fn().mockReturnValue(group),
      });

      mockFindChannel.mockReturnValue(channel);
      mockGetMessagesSince.mockReturnValue(messages);
      mockLoadSenderAllowlist.mockReturnValue({});
      mockIsTriggerAllowed.mockReturnValue(true);

      let capturedDeps: Record<string, unknown> = {};
      mockHandleSessionCommand.mockImplementation(async (arg: { deps: Record<string, unknown> }) => {
        capturedDeps = arg.deps;
        return { handled: true, success: true };
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      return { capturedDeps, deps, channel, group };
    }

    it('sendMessage delegates to channel.sendMessage with the chatJid', async () => {
      const { capturedDeps, channel } = await captureSessionDeps();
      const sendMessage = capturedDeps.sendMessage as (text: string) => Promise<void>;

      await sendMessage('hello from session cmd');

      expect(channel.sendMessage).toHaveBeenCalledWith('group1@g.us', 'hello from session cmd');
    });

    it('setTyping delegates to channel.setTyping', async () => {
      const { capturedDeps, channel } = await captureSessionDeps();
      const setTyping = capturedDeps.setTyping as (typing: boolean) => Promise<void>;

      await setTyping(true);

      expect(channel.setTyping).toHaveBeenCalledWith('group1@g.us', true);
    });

    it('closeStdin delegates to deps.queue.closeStdin', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const closeStdin = capturedDeps.closeStdin as () => void;

      closeStdin();

      expect(deps.queue.closeStdin).toHaveBeenCalledWith('group1@g.us');
    });

    it('advanceCursor sets cursor and saves state', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const advanceCursor = capturedDeps.advanceCursor as (ts: string) => void;

      advanceCursor('1700099999');

      expect(deps.setCursor).toHaveBeenCalledWith('group1@g.us', '1700099999');
      expect(deps.saveState).toHaveBeenCalled();
    });

    it('getDefaultModel returns model from config', async () => {
      const { capturedDeps } = await captureSessionDeps();
      const getDefaultModel = capturedDeps.getDefaultModel as () => string | undefined;

      expect(getDefaultModel()).toBeUndefined();
    });

    it('getGroupModelOverride returns the group agentConfig.model', async () => {
      const group = makeGroup({ isMain: true, agentConfig: { model: 'opus' } });
      const { capturedDeps } = await captureSessionDeps({ group });
      const getGroupModelOverride = capturedDeps.getGroupModelOverride as () => string | undefined;

      expect(getGroupModelOverride()).toBe('opus');
    });

    it('setGroupModelOverride delegates to deps', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const setGroupModelOverride = capturedDeps.setGroupModelOverride as (v: string | undefined) => void;

      setGroupModelOverride('sonnet');

      expect(deps.setGroupModelOverride).toHaveBeenCalledWith('group1@g.us', 'sonnet');
    });

    it('getGroupThinkingOverride returns the group agentConfig.thinking', async () => {
      const group = makeGroup({
        isMain: true,
        agentConfig: { thinking: { mode: 'enabled' } },
      });
      const { capturedDeps } = await captureSessionDeps({ group });
      const getGroupThinkingOverride = capturedDeps.getGroupThinkingOverride as () => unknown;

      expect(getGroupThinkingOverride()).toEqual({ mode: 'enabled' });
    });

    it('setGroupThinkingOverride delegates to deps', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const setGroupThinkingOverride = capturedDeps.setGroupThinkingOverride as (v: unknown) => void;

      setGroupThinkingOverride({ mode: 'disabled' });

      expect(deps.setGroupThinkingOverride).toHaveBeenCalledWith(
        'group1@g.us',
        { mode: 'disabled' },
      );
    });

    it('getRuntimeStatusMessage calls diagnostics and formats result', async () => {
      const { capturedDeps } = await captureSessionDeps();
      const getRuntimeStatusMessage = capturedDeps.getRuntimeStatusMessage as () => Promise<string>;

      mockCollectRuntimeDiagnostics.mockResolvedValue({ ok: true });
      mockFormatRuntimeDiagnosticsMessage.mockReturnValue('all good');

      const msg = await getRuntimeStatusMessage();

      expect(mockCollectRuntimeDiagnostics).toHaveBeenCalled();
      expect(mockFormatRuntimeDiagnosticsMessage).toHaveBeenCalledWith({ ok: true });
      expect(msg).toBe('all good');
    });

    it('archiveCurrentSession archives when session exists', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const archiveCurrentSession = capturedDeps.archiveCurrentSession as () => Promise<void>;
      (deps.getSession as ReturnType<typeof vi.fn>).mockReturnValue('sess-to-archive');

      await archiveCurrentSession();

      expect(mockArchiveSessionTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          groupFolder: 'grp-folder',
          sessionId: 'sess-to-archive',
          assistantName: 'Andy',
          cause: 'new-session',
        }),
      );
    });

    it('archiveCurrentSession does nothing when no session', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const archiveCurrentSession = capturedDeps.archiveCurrentSession as () => Promise<void>;
      (deps.getSession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

      await archiveCurrentSession();

      expect(mockArchiveSessionTranscript).not.toHaveBeenCalled();
    });

    it('onSessionArchived calls memory reflectAfterTurn with /new', async () => {
      const { capturedDeps } = await captureSessionDeps();
      const onSessionArchived = capturedDeps.onSessionArchived as () => Promise<void>;
      mockReflectAfterTurn.mockResolvedValue(undefined);

      await onSessionArchived();

      expect(mockReflectAfterTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          groupFolder: 'grp-folder',
          prompt: '/new',
          result: 'session archived',
          isMain: true,
        }),
      );
    });

    it('clearCurrentSession clears session and deletes from DB', async () => {
      const { capturedDeps, deps } = await captureSessionDeps();
      const clearCurrentSession = capturedDeps.clearCurrentSession as () => void;

      clearCurrentSession();

      expect(deps.clearSession).toHaveBeenCalledWith('grp-folder');
      expect(mockDeleteSession).toHaveBeenCalledWith('grp-folder');
    });

    describe('canSenderInteract', () => {
      it('returns true for main group regardless of trigger', async () => {
        const group = makeGroup({ isMain: true });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (msg: NewMessage) => boolean;

        const msg = makeMessage({ content: 'no trigger' });
        expect(canSenderInteract(msg)).toBe(true);
      });

      it('returns true for non-main group with requiresTrigger=false', async () => {
        const group = makeGroup({ isMain: false, requiresTrigger: false });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (msg: NewMessage) => boolean;

        const msg = makeMessage({ content: 'no trigger' });
        expect(canSenderInteract(msg)).toBe(true);
      });

      it('returns true for non-main group when trigger present and is_from_me', async () => {
        const group = makeGroup({ isMain: false, requiresTrigger: true, trigger: 'Andy' });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (msg: NewMessage) => boolean;

        const msg = makeMessage({ content: '@Andy hello', is_from_me: true });
        expect(canSenderInteract(msg)).toBe(true);
      });

      it('returns true for non-main group when trigger present and sender is allowlisted', async () => {
        const group = makeGroup({ isMain: false, requiresTrigger: true, trigger: 'Andy' });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (msg: NewMessage) => boolean;
        mockIsTriggerAllowed.mockReturnValue(true);

        const msg = makeMessage({ content: '@Andy hello', is_from_me: false });
        expect(canSenderInteract(msg)).toBe(true);
      });

      it('returns false for non-main group when trigger present but sender not allowed', async () => {
        const group = makeGroup({ isMain: false, requiresTrigger: true, trigger: 'Andy' });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (msg: NewMessage) => boolean;
        mockIsTriggerAllowed.mockReturnValue(false);

        const msg = makeMessage({ content: '@Andy hello', is_from_me: false });
        expect(canSenderInteract(msg)).toBe(false);
      });

      it('returns false for non-main group when no trigger in message', async () => {
        const group = makeGroup({ isMain: false, requiresTrigger: true, trigger: 'Andy' });
        const { capturedDeps } = await captureSessionDeps({ group });
        const canSenderInteract = capturedDeps.canSenderInteract as (msg: NewMessage) => boolean;

        const msg = makeMessage({ content: 'just chatting', is_from_me: false });
        expect(canSenderInteract(msg)).toBe(false);
      });
    });

    it('runAgent delegates to the internal runAgent function', async () => {
      const group = makeGroup({ isMain: true, folder: 'grp-folder' });
      const channel = makeChannel();
      const messages = [makeMessage()];

      const deps = makeDeps({
        channels: [channel],
        getGroup: vi.fn().mockReturnValue(group),
      });

      mockFindChannel.mockReturnValue(channel);
      mockGetMessagesSince.mockReturnValue(messages);
      mockGetAllJobs.mockReturnValue([]);
      mockGetRecentJobRuns.mockReturnValue([]);
      mockWriteMemoryContextSnapshot.mockResolvedValue({ retrievedItemIds: [] });
      mockLoadSenderAllowlist.mockReturnValue({});

      let capturedRunAgent: (
        prompt: string,
        onOutput?: (output: AgentOutput) => Promise<void>,
        options?: { timeoutMs?: number },
      ) => Promise<'success' | 'error'>;

      mockHandleSessionCommand.mockImplementation(async (arg: { deps: Record<string, unknown> }) => {
        capturedRunAgent = arg.deps.runAgent as typeof capturedRunAgent;
        return { handled: true, success: true };
      });

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // Now invoke the captured runAgent
      mockSpawnAgent.mockResolvedValue({ status: 'success', result: 'ok' } as AgentOutput);

      const result = await capturedRunAgent!('test prompt');
      expect(result).toBe('success');
      expect(mockSpawnAgent).toHaveBeenCalledWith(
        group,
        expect.objectContaining({ prompt: 'test prompt' }),
        expect.any(Function),
        undefined,
        undefined,
      );
    });
  });

  // =========================================================================
  // Bug-hunting: adversarial edge cases
  // =========================================================================

  describe('stale session set from errored agent run', () => {
    it('should not set session ID when agent returns error status', async () => {
      // Bug: group-processing.ts lines 163-166 call deps.setSession(newSessionId)
      // BEFORE checking output.status === 'error' at line 167.
      // This means a session ID from a failed run gets persisted,
      // potentially pointing to a broken/incomplete session.
      const group = makeGroup({ isMain: true });
      const channel = makeChannel();
      const messages = [makeMessage()];

      const deps = makeDeps({
        channels: [channel],
        getGroup: vi.fn().mockReturnValue(group),
        getCursor: vi.fn().mockReturnValue('0'),
      });

      mockFindChannel.mockReturnValue(channel);
      mockGetMessagesSince.mockReturnValue(messages);
      mockHandleSessionCommand.mockResolvedValue({ handled: false });
      mockFormatMessages.mockReturnValue('formatted prompt');
      mockGetAllJobs.mockReturnValue([]);
      mockGetRecentJobRuns.mockReturnValue([]);
      mockWriteMemoryContextSnapshot.mockResolvedValue({
        retrievedItemIds: [],
      });
      mockLoadSenderAllowlist.mockReturnValue({});

      // Agent returns error WITH a newSessionId
      mockSpawnAgent.mockImplementation(
        async (
          _group: unknown,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          const errorOutput: AgentOutput = {
            status: 'error',
            result: null,
            error: 'something broke',
            newSessionId: 'broken-session-123',
          };
          await onOutput?.(errorOutput);
          return errorOutput;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // Session should NOT be set from a failed agent run.
      // If this fails, it means broken session IDs leak into state.
      expect(deps.setSession).not.toHaveBeenCalledWith(
        'test-group',
        'broken-session-123',
      );
    });
  });

  describe('double setSession from streamed + final output', () => {
    it('should only call setSession once per agent run', async () => {
      // Bug: wrappedOnOutput (line 133) and the post-spawnAgent block (line 163)
      // both check output.newSessionId and call deps.setSession.
      // When onOutput is provided and spawnAgent returns the same newSessionId,
      // setSession is called twice — redundant at best, confusing at worst.
      const group = makeGroup({ isMain: true });
      const channel = makeChannel();
      const messages = [makeMessage()];

      const deps = makeDeps({
        channels: [channel],
        getGroup: vi.fn().mockReturnValue(group),
        getCursor: vi.fn().mockReturnValue('0'),
      });

      mockFindChannel.mockReturnValue(channel);
      mockGetMessagesSince.mockReturnValue(messages);
      mockHandleSessionCommand.mockResolvedValue({ handled: false });
      mockFormatMessages.mockReturnValue('formatted prompt');
      mockGetAllJobs.mockReturnValue([]);
      mockGetRecentJobRuns.mockReturnValue([]);
      mockWriteMemoryContextSnapshot.mockResolvedValue({
        retrievedItemIds: [],
      });
      mockLoadSenderAllowlist.mockReturnValue({});

      mockSpawnAgent.mockImplementation(
        async (
          _group: unknown,
          _input: unknown,
          _onProc: unknown,
          onOutput?: (output: AgentOutput) => Promise<void>,
        ) => {
          const output: AgentOutput = {
            status: 'success',
            result: 'hello',
            newSessionId: 'session-42',
          };
          await onOutput?.(output);
          return output;
        },
      );

      const { processGroupMessages } = createGroupProcessor(deps);
      await processGroupMessages('group1@g.us');

      // setSession should be called exactly once, not twice
      const setSessionCalls = (deps.setSession as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => call[1] === 'session-42',
      );
      expect(setSessionCalls).toHaveLength(1);
    });
  });
});
