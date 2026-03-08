import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('./sender-allowlist.js', () => ({
  isTriggerAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: true,
  })),
}));

import { _initTestDatabase, storeChatMetadata, storeMessage } from './db.js';
import {
  processGroupMessages,
  recoverPendingMessages,
  type MessageProcessorDeps,
} from './message-processor.js';
import type { Channel, RegisteredGroup } from './types.js';

function createMockChannel(): Channel {
  return {
    name: 'test-channel',
    connect: async () => {},
    sendMessage: vi.fn(async () => {}),
    isConnected: () => true,
    ownsJid: () => true,
    disconnect: async () => {},
    setTyping: vi.fn(async () => {}),
  };
}

const TEST_GROUP: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const NON_MAIN_GROUP: RegisteredGroup = {
  name: 'Other Group',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const mockRunAgent = vi.fn<MessageProcessorDeps['runAgent']>();
const mockQueue = {
  closeStdin: vi.fn(),
  notifyIdle: vi.fn(),
  enqueueMessageCheck: vi.fn(),
  registerOnPiped: vi.fn(),
};

function createDeps(
  overrides: Partial<MessageProcessorDeps> = {},
): MessageProcessorDeps {
  return {
    registeredGroups: () => ({}),
    findChannel: () => undefined,
    getAgentCursor: () => '',
    setAgentCursor: () => {},
    runAgent: mockRunAgent,
    queue: mockQueue,
    assistantName: 'Andy',
    triggerPattern: /^@Andy\b/i,
    idleTimeout: 1800000,
    timezone: 'UTC',
    ...overrides,
  };
}

beforeEach(() => {
  _initTestDatabase();
  mockRunAgent.mockReset();
  mockQueue.closeStdin.mockClear();
  mockQueue.notifyIdle.mockClear();
  mockQueue.registerOnPiped.mockClear();
  mockQueue.enqueueMessageCheck.mockClear();
});

// --- processGroupMessages ---

describe('processGroupMessages', () => {
  it('returns true when no messages pending', async () => {
    const ch = createMockChannel();
    const deps = createDeps({
      registeredGroups: () => ({ 'group@g.us': TEST_GROUP }),
      findChannel: () => ch,
    });

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    const result = await processGroupMessages('group@g.us', deps);
    expect(result).toBe(true);
  });

  it('returns true for unregistered group', async () => {
    const deps = createDeps();
    const result = await processGroupMessages('unknown@g.us', deps);
    expect(result).toBe(true);
  });

  it('returns true when no channel owns JID', async () => {
    const deps = createDeps({
      registeredGroups: () => ({ 'group@g.us': TEST_GROUP }),
    });

    const result = await processGroupMessages('group@g.us', deps);
    expect(result).toBe(true);
  });

  it('advances cursor on success', async () => {
    const cursors: Record<string, string> = {};
    const ch = createMockChannel();
    const deps = createDeps({
      registeredGroups: () => ({ 'group@g.us': TEST_GROUP }),
      findChannel: () => ch,
      getAgentCursor: (chatJid) => cursors[chatJid] || '',
      setAgentCursor: (chatJid, ts) => {
        cursors[chatJid] = ts;
      },
    });

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    mockRunAgent.mockImplementation(
      async (_group, _prompt, _chatJid, onOutput) => {
        if (onOutput) {
          await onOutput({ status: 'success', result: 'reply' });
        }
        return 'success';
      },
    );

    const result = await processGroupMessages('group@g.us', deps);
    expect(result).toBe(true);
    expect(cursors['group@g.us']).toBe('2024-01-01T00:00:01.000Z');
  });

  it('rolls back cursor on error when no output was sent', async () => {
    const cursors: Record<string, string> = {
      'group@g.us': '2024-01-01T00:00:00.500Z',
    };
    const ch = createMockChannel();
    const deps = createDeps({
      registeredGroups: () => ({ 'group@g.us': TEST_GROUP }),
      findChannel: () => ch,
      getAgentCursor: (chatJid) => cursors[chatJid] || '',
      setAgentCursor: (chatJid, ts) => {
        cursors[chatJid] = ts;
      },
    });

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    mockRunAgent.mockImplementation(async () => 'error');

    const result = await processGroupMessages('group@g.us', deps);
    expect(result).toBe(false);
    expect(cursors['group@g.us']).toBe('2024-01-01T00:00:00.500Z');
  });

  it('does NOT roll back cursor on error if output was already sent to user', async () => {
    const cursors: Record<string, string> = {};
    const ch = createMockChannel();
    const deps = createDeps({
      registeredGroups: () => ({ 'group@g.us': TEST_GROUP }),
      findChannel: () => ch,
      getAgentCursor: (chatJid) => cursors[chatJid] || '',
      setAgentCursor: (chatJid, ts) => {
        cursors[chatJid] = ts;
      },
    });

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    mockRunAgent.mockImplementation(
      async (_group, _prompt, _chatJid, onOutput) => {
        if (onOutput) {
          await onOutput({ status: 'success', result: 'partial reply' });
          await onOutput({
            status: 'error',
            result: null,
            error: 'late error',
          });
        }
        return 'error';
      },
    );

    const result = await processGroupMessages('group@g.us', deps);
    expect(result).toBe(true);
    expect(cursors['group@g.us']).toBe('2024-01-01T00:00:01.000Z');
  });

  it('rolls back cursor on error if follow-up was piped after last output', async () => {
    const cursors: Record<string, string> = {
      'group@g.us': '2024-01-01T00:00:00.500Z',
    };
    const ch = createMockChannel();
    const deps = createDeps({
      registeredGroups: () => ({ 'group@g.us': TEST_GROUP }),
      findChannel: () => ch,
      getAgentCursor: (chatJid) => cursors[chatJid] || '',
      setAgentCursor: (chatJid, ts) => {
        cursors[chatJid] = ts;
      },
    });

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    mockRunAgent.mockImplementation(
      async (_group, _prompt, _chatJid, onOutput) => {
        if (onOutput) {
          // Agent sends first reply (sets outputSentToUser)
          await onOutput({ status: 'success', result: 'first reply' });
        }
        // Simulate a follow-up being piped after output was sent
        const pipedCb = mockQueue.registerOnPiped.mock.calls.find(
          (c) => c[0] === 'group@g.us',
        )?.[1];
        pipedCb?.();
        // Agent then fails before responding to the piped follow-up
        return 'error';
      },
    );

    const result = await processGroupMessages('group@g.us', deps);
    // Should retry (return false) and roll back cursor despite earlier output
    expect(result).toBe(false);
    expect(cursors['group@g.us']).toBe('2024-01-01T00:00:00.500Z');
  });

  it('sends message to channel on agent output', async () => {
    const ch = createMockChannel();
    const deps = createDeps({
      registeredGroups: () => ({ 'group@g.us': TEST_GROUP }),
      findChannel: () => ch,
    });

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    mockRunAgent.mockImplementation(
      async (_group, _prompt, _chatJid, onOutput) => {
        if (onOutput) {
          await onOutput({ status: 'success', result: 'hello back!' });
        }
        return 'success';
      },
    );

    await processGroupMessages('group@g.us', deps);
    expect(ch.sendMessage).toHaveBeenCalledWith('group@g.us', 'hello back!');
  });

  it('strips <internal> tags from agent output before sending', async () => {
    const ch = createMockChannel();
    const deps = createDeps({
      registeredGroups: () => ({ 'group@g.us': TEST_GROUP }),
      findChannel: () => ch,
    });

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    mockRunAgent.mockImplementation(
      async (_group, _prompt, _chatJid, onOutput) => {
        if (onOutput) {
          await onOutput({
            status: 'success',
            result: 'visible <internal>hidden</internal> text',
          });
        }
        return 'success';
      },
    );

    await processGroupMessages('group@g.us', deps);
    expect(ch.sendMessage).toHaveBeenCalledWith('group@g.us', 'visible  text');
  });

  it('starts idle timer on tool-call-only completion (null result)', async () => {
    vi.useFakeTimers();
    const ch = createMockChannel();
    const deps = createDeps({
      registeredGroups: () => ({ 'group@g.us': TEST_GROUP }),
      findChannel: () => ch,
      idleTimeout: 5000,
    });

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    // Simulate a container that stays alive until closeStdin fires
    mockRunAgent.mockImplementation(
      async (_group, _prompt, _chatJid, onOutput) => {
        if (onOutput) {
          await onOutput({ status: 'success', result: null });
        }
        // Block until idle timer triggers closeStdin
        await new Promise<void>((resolve) => {
          const orig = mockQueue.closeStdin.getMockImplementation();
          mockQueue.closeStdin.mockImplementation((...args) => {
            orig?.(...args);
            resolve();
          });
        });
        return 'success';
      },
    );

    const promise = processGroupMessages('group@g.us', deps);

    // Idle timer should have been started; advance past it
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    expect(mockQueue.closeStdin).toHaveBeenCalledWith('group@g.us');
    expect(ch.sendMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not send message when result is internal-only', async () => {
    const ch = createMockChannel();
    const deps = createDeps({
      registeredGroups: () => ({ 'group@g.us': TEST_GROUP }),
      findChannel: () => ch,
    });

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    mockRunAgent.mockImplementation(
      async (_group, _prompt, _chatJid, onOutput) => {
        if (onOutput) {
          await onOutput({
            status: 'success',
            result: '<internal>only internal</internal>',
          });
        }
        return 'success';
      },
    );

    await processGroupMessages('group@g.us', deps);
    expect(ch.sendMessage).not.toHaveBeenCalled();
  });
});

// --- recoverPendingMessages ---

describe('recoverPendingMessages', () => {
  it('enqueues groups that have pending messages after crash', () => {
    const deps = createDeps({
      registeredGroups: () => ({
        'group1@g.us': TEST_GROUP,
        'group2@g.us': { ...NON_MAIN_GROUP, folder: 'group2' },
      }),
    });

    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'pending-1',
      chat_jid: 'group1@g.us',
      sender: 'user@s',
      sender_name: 'User',
      content: 'unprocessed message',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    recoverPendingMessages(deps);

    expect(mockQueue.enqueueMessageCheck).toHaveBeenCalledWith('group1@g.us');
    expect(mockQueue.enqueueMessageCheck).not.toHaveBeenCalledWith(
      'group2@g.us',
    );
  });

  it('skips groups with no pending messages', () => {
    const deps = createDeps({
      registeredGroups: () => ({ 'group@g.us': TEST_GROUP }),
      getAgentCursor: () => '2024-01-01T00:00:10.000Z',
    });

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    recoverPendingMessages(deps);

    expect(mockQueue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('recovers messages when lastAgentTimestamp is empty', () => {
    const deps = createDeps({
      registeredGroups: () => ({ 'group@g.us': TEST_GROUP }),
    });

    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: 'user@s',
      sender_name: 'User',
      content: 'old message',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    recoverPendingMessages(deps);

    expect(mockQueue.enqueueMessageCheck).toHaveBeenCalledWith('group@g.us');
  });
});
