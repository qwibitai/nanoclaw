/**
 * Tests for processGroupMessages — specifically the cursor-rollback logic
 * that allows rate-limit errors to roll back the cursor even when output has
 * already been sent to the user.
 *
 * These tests exercise the exact condition we changed:
 *   OLD: if (outputSentToUser) skip rollback
 *   NEW: if (outputSentToUser && !rateLimitResetAt) skip rollback
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks — must be created before vi.mock() factories run ─────────────

const { mockRunContainerAgent, mockFindChannel } = vi.hoisted(() => ({
  mockRunContainerAgent: vi.fn(),
  mockFindChannel: vi.fn(),
}));

// ── Module mocks ───────────────────────────────────────────────────────────────

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'TestBot',
  IDLE_TIMEOUT: 60_000,
  MAIN_GROUP_FOLDER: 'main',
  POLL_INTERVAL: 5000,
  TRIGGER_PATTERN: /@TestBot/i,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}));

vi.mock('./db.js', () => ({
  getAllChats: vi.fn(() => []),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getAllSessions: vi.fn(() => ({})),
  getAllTasks: vi.fn(() => []),
  getMessagesSince: vi.fn(),
  getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
  getRouterState: vi.fn(() => ''),
  initDatabase: vi.fn(),
  setRegisteredGroup: vi.fn(),
  setRouterState: vi.fn(),
  setSession: vi.fn(),
  storeChatMetadata: vi.fn(),
  storeMessage: vi.fn(),
}));

vi.mock('./router.js', () => ({
  escapeXml: (s: string) => s,
  findChannel: mockFindChannel,
  formatMessages: vi.fn(() => 'Formatted prompt'),
  formatOutbound: (s: string) => s,
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: mockRunContainerAgent,
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => `/tmp/test/${folder}`,
  resolveGroupIpcPath: (folder: string) => `/tmp/test/${folder}/ipc`,
}));

vi.mock('./container-runtime.js', () => ({
  cleanupOrphans: vi.fn(),
  ensureContainerRuntimeRunning: vi.fn(),
  CONTAINER_RUNTIME_BIN: 'docker',
  readonlyMountArgs: vi.fn(() => []),
  stopContainer: vi.fn(() => 'docker stop test'),
}));

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));
vi.mock('./ipc.js', () => ({ startIpcWatcher: vi.fn() }));
vi.mock('./task-scheduler.js', () => ({ startSchedulerLoop: vi.fn() }));
vi.mock('./channels/whatsapp.js', () => ({ WhatsAppChannel: vi.fn() }));
vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      cpSync: vi.fn(),
    },
  };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  _processGroupMessages,
  _setRegisteredGroups,
  _setLastAgentTimestamp,
  _getLastAgentTimestamp,
} from './index.js';
import { getMessagesSince } from './db.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_JID = 'group1@g.us';
const TEST_GROUP = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@TestBot',
  added_at: new Date().toISOString(),
};

const PENDING_MSG = {
  id: 'msg-1',
  chat_jid: TEST_JID,
  sender: 'user@s.whatsapp.net',
  sender_name: 'Test User',
  content: '@TestBot hello',
  timestamp: '2025-01-01T01:00:00.000Z',
  is_from_me: false,
};

function makeFakeChannel() {
  const sent: string[] = [];
  return {
    owns: vi.fn(() => true),
    sendMessage: vi.fn(async (_jid: string, text: string) => {
      sent.push(text);
    }),
    setTyping: vi.fn(async () => {}),
    sent,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('processGroupMessages — cursor rollback on error', () => {
  let fakeChannel: ReturnType<typeof makeFakeChannel>;

  beforeEach(() => {
    vi.useFakeTimers();

    fakeChannel = makeFakeChannel();
    mockFindChannel.mockReturnValue(fakeChannel);

    vi.mocked(getMessagesSince).mockReturnValue([PENDING_MSG]);

    _setRegisteredGroups({ [TEST_JID]: TEST_GROUP });
    _setLastAgentTimestamp({ [TEST_JID]: '2025-01-01T00:00:00.000Z' }); // old cursor
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('rolls back cursor and returns { success: false, rateLimitResetAt } when rate limit fires after output sent', async () => {
    // Critical scenario: user message is being processed, Claude hits rate limit
    // and outputs the notice text. The notice IS forwarded to WhatsApp so the user
    // knows about it. But we MUST roll back the cursor so the original message gets
    // re-processed once the limit resets — the user's request was never answered.
    const resetAt = '2025-01-01T10:00:00.000Z';

    mockRunContainerAgent.mockImplementation(
      async (
        _group: unknown,
        _input: unknown,
        _onProcess: unknown,
        onOutput: ((out: unknown) => Promise<void>) | undefined,
      ) => {
        if (onOutput) {
          await onOutput({
            status: 'error',
            result:
              "You've hit your usage limit · resets 2am (America/Los_Angeles)",
            rateLimitResetAt: resetAt,
          });
          // Simulate session-update marker
          await onOutput({
            status: 'success',
            result: null,
            newSessionId: 'sess-1',
          });
        }
        return { status: 'success', result: null, newSessionId: 'sess-1' };
      },
    );

    const result = await _processGroupMessages(TEST_JID);

    // Rate-limit notice was forwarded to the user
    expect(fakeChannel.sendMessage).toHaveBeenCalledWith(
      TEST_JID,
      expect.stringContaining('resets 2am'),
    );

    // Cursor MUST roll back to the old position so the message is retried
    expect(_getLastAgentTimestamp()[TEST_JID]).toBe('2025-01-01T00:00:00.000Z');

    // Return value drives GroupQueue to schedule a retry at the right time
    expect(result.success).toBe(false);
    expect(result.rateLimitResetAt).toBeInstanceOf(Date);
    expect(result.rateLimitResetAt!.toISOString()).toBe(resetAt);
  });

  it('does NOT roll back cursor for regular errors when output was already sent', async () => {
    // If the agent crashes MID-response, rolling back would resend duplicate output.
    // We suppress retries by returning success.
    mockRunContainerAgent.mockImplementation(
      async (
        _group: unknown,
        _input: unknown,
        _onProcess: unknown,
        onOutput: ((out: unknown) => Promise<void>) | undefined,
      ) => {
        if (onOutput) {
          // Some output sent to user, then error (no rateLimitResetAt)
          await onOutput({ status: 'error', result: 'Partial response.' });
        }
        return { status: 'success', result: null };
      },
    );

    const result = await _processGroupMessages(TEST_JID);

    expect(fakeChannel.sendMessage).toHaveBeenCalled();

    // Cursor must NOT roll back — user already got output
    expect(_getLastAgentTimestamp()[TEST_JID]).toBe('2025-01-01T01:00:00.000Z');
    expect(result.success).toBe(true);
    expect(result.rateLimitResetAt).toBeUndefined();
  });

  it('rolls back cursor for any error when no output was sent yet', async () => {
    // Error before any output: safe to retry — user got nothing yet
    mockRunContainerAgent.mockImplementation(
      async (
        _group: unknown,
        _input: unknown,
        _onProcess: unknown,
        onOutput: ((out: unknown) => Promise<void>) | undefined,
      ) => {
        if (onOutput) {
          await onOutput({ status: 'error', result: null });
        }
        return { status: 'error', result: null };
      },
    );

    const result = await _processGroupMessages(TEST_JID);

    expect(fakeChannel.sendMessage).not.toHaveBeenCalled();

    // Cursor rolled back so the message can be retried
    expect(_getLastAgentTimestamp()[TEST_JID]).toBe('2025-01-01T00:00:00.000Z');
    expect(result.success).toBe(false);
  });
});
