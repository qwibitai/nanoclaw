import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mockGetNewMessages = vi.fn();
const mockGetMessagesSince = vi.fn();
const mockGetTriggerPattern = vi.fn();
const mockLoadSenderAllowlist = vi.fn();
const mockIsTriggerAllowed = vi.fn();
const mockExtractSessionCommand = vi.fn();
const mockIsSessionCommandAllowed = vi.fn();
const mockFormatMessages = vi.fn();

vi.mock('../storage/db.js', () => ({
  getNewMessages: (...args: unknown[]) => mockGetNewMessages(...args),
  getMessagesSince: (...args: unknown[]) => mockGetMessagesSince(...args),
}));
vi.mock('../core/config.js', () => ({
  getTriggerPattern: (...args: unknown[]) => mockGetTriggerPattern(...args),
  POLL_INTERVAL: 100,
  MAX_MESSAGES_PER_PROMPT: 50,
  TIMEZONE: 'UTC',
}));
vi.mock('../platform/sender-allowlist.js', () => ({
  loadSenderAllowlist: (...args: unknown[]) => mockLoadSenderAllowlist(...args),
  isTriggerAllowed: (...args: unknown[]) => mockIsTriggerAllowed(...args),
}));
vi.mock('../session/session-commands.js', () => ({
  extractSessionCommand: (...args: unknown[]) =>
    mockExtractSessionCommand(...args),
  isSessionCommandAllowed: (...args: unknown[]) =>
    mockIsSessionCommandAllowed(...args),
}));
vi.mock('../messaging/router.js', () => ({
  formatMessages: (...args: unknown[]) => mockFormatMessages(...args),
}));

import { MessageLoopDeps, recoverPendingMessages } from './message-loop.js';
import { Channel, RegisteredGroup } from '../core/types.js';

function makeDeps(
  overrides: Partial<MessageLoopDeps> = {},
): MessageLoopDeps & {
  enqueued: string[];
  cursors: Record<string, string>;
  sentTo: string[];
  closedStdin: string[];
  savedCount: number;
} {
  const enqueued: string[] = [];
  const cursors: Record<string, string> = {};
  const sentTo: string[] = [];
  const closedStdin: string[] = [];
  let savedCount = 0;

  const deps: MessageLoopDeps & {
    enqueued: string[];
    cursors: Record<string, string>;
    sentTo: string[];
    closedStdin: string[];
    savedCount: number;
  } = {
    assistantName: 'Andy',
    getRegisteredGroups: () => ({
      'group@g.us': {
        name: 'Team',
        folder: 'team',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      },
    }),
    getLastTimestamp: () => '2024-01-01T00:00:00.000Z',
    setLastTimestamp: vi.fn(),
    getOrRecoverCursor: (chatJid: string) =>
      cursors[chatJid] || '2024-01-01T00:00:00.000Z',
    setAgentCursor: (chatJid: string, ts: string) => {
      cursors[chatJid] = ts;
    },
    saveState: () => {
      savedCount += 1;
    },
    findChannel: () =>
      ({
        name: 'test',
        owns: () => true,
        sendMessage: async () => {},
        setTyping: vi.fn().mockResolvedValue(undefined),
      }) as unknown as Channel,
    queue: {
      sendMessage: (chatJid: string) => {
        sentTo.push(chatJid);
        return true;
      },
      enqueueMessageCheck: (chatJid: string) => {
        enqueued.push(chatJid);
      },
      closeStdin: (chatJid: string) => {
        closedStdin.push(chatJid);
      },
    },
    enqueued,
    cursors,
    sentTo,
    closedStdin,
    savedCount,
    ...overrides,
  };
  return deps;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNewMessages.mockReturnValue({ messages: [], newTimestamp: '' });
  mockGetMessagesSince.mockReturnValue([]);
  mockGetTriggerPattern.mockReturnValue(/@Andy/i);
  mockLoadSenderAllowlist.mockReturnValue({});
  mockIsTriggerAllowed.mockReturnValue(true);
  mockExtractSessionCommand.mockReturnValue(null);
  mockIsSessionCommandAllowed.mockReturnValue(false);
  mockFormatMessages.mockReturnValue('formatted messages');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('recoverPendingMessages', () => {
  it('enqueues message checks for groups with pending messages', () => {
    mockGetMessagesSince.mockReturnValue([
      {
        id: 1,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        content: 'hello',
        timestamp: '2024-01-01T00:00:01.000Z',
        is_from_me: false,
        message_id: 'msg-1',
        reply_to_message_id: null,
        reply_to_content: null,
        sender_name: 'User',
      },
    ]);

    const deps = makeDeps();
    recoverPendingMessages(deps);

    expect(deps.enqueued).toContain('group@g.us');
  });

  it('does not enqueue when no pending messages exist', () => {
    mockGetMessagesSince.mockReturnValue([]);

    const deps = makeDeps();
    recoverPendingMessages(deps);

    expect(deps.enqueued).toHaveLength(0);
  });

  it('checks all registered groups', () => {
    mockGetMessagesSince.mockReturnValue([
      {
        id: 1,
        chat_jid: 'group1@g.us',
        sender: 'user@s.whatsapp.net',
        content: 'hello',
        timestamp: '2024-01-01T00:00:01.000Z',
        is_from_me: false,
        message_id: 'msg-1',
        reply_to_message_id: null,
        reply_to_content: null,
        sender_name: 'User',
      },
    ]);

    const deps = makeDeps({
      getRegisteredGroups: () => ({
        'group1@g.us': {
          name: 'Team 1',
          folder: 'team1',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
        'group2@g.us': {
          name: 'Team 2',
          folder: 'team2',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
    });

    recoverPendingMessages(deps);
    expect(deps.enqueued).toEqual(['group1@g.us', 'group2@g.us']);
  });
});

describe('startMessagePollingLoop', () => {
  it('processes new messages and pipes them to the queue', async () => {
    const msg = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg]);

    const deps = makeDeps();
    const { startMessagePollingLoop } = await import('./message-loop.js');

    // Run one iteration then abort
    const controller = new AbortController();
    const loopPromise = startMessagePollingLoop(deps);

    // Give it time to process one iteration
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toContain('group@g.us');
    expect(deps.cursors['group@g.us']).toBe('2024-01-01T00:00:01.000Z');

    // We can't cleanly stop the infinite loop in tests, so we just verify behavior
    // The loop will be cleaned up when the test ends
  });

  it('skips groups with no channel', async () => {
    const msg = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });

    const deps = makeDeps({ findChannel: () => undefined });
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toHaveLength(0);
  });

  it('enqueues message check when sendMessage returns false', async () => {
    const msg = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg]);

    const deps = makeDeps({
      queue: {
        sendMessage: () => false,
        enqueueMessageCheck: (jid: string) => deps.enqueued.push(jid),
        closeStdin: () => {},
      },
    });
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.enqueued).toContain('group@g.us');
  });

  it('handles session commands by closing stdin and enqueuing', async () => {
    const msg = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: '@Andy /new',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockExtractSessionCommand.mockReturnValue('/new');
    mockIsSessionCommandAllowed.mockReturnValue(true);

    const deps = makeDeps();
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.closedStdin).toContain('group@g.us');
    expect(deps.enqueued).toContain('group@g.us');
  });

  it('skips non-main groups without trigger match', async () => {
    const msg = {
      id: 1,
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello no trigger',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      message_id: 'msg-1',
      reply_to_message_id: null,
      reply_to_content: null,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetTriggerPattern.mockReturnValue(/@Andy/i);

    const deps = makeDeps({
      getRegisteredGroups: () => ({
        'group@g.us': {
          name: 'Team',
          folder: 'team',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
    });
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toHaveLength(0);
  });

  it('recovers from errors in the loop body', async () => {
    // First call throws, second returns empty
    mockGetNewMessages
      .mockImplementationOnce(() => {
        throw new Error('db connection lost');
      })
      .mockReturnValue({ messages: [], newTimestamp: '' });

    const deps = makeDeps();
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 250));

    // Loop should survive the error and keep running
    expect(mockGetNewMessages.mock.calls.length).toBeGreaterThan(1);
  });

  it('groups multiple messages by chat_jid (covers existing.push branch)', async () => {
    const msg1 = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user1@s.whatsapp.net',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User1',
    };
    const msg2 = {
      id: '2',
      chat_jid: 'group@g.us',
      sender: 'user2@s.whatsapp.net',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
      is_from_me: false,
      sender_name: 'User2',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg1, msg2],
      newTimestamp: '2024-01-01T00:00:02.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg1, msg2]);

    const deps = makeDeps();
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    // Both messages were grouped under the same JID and sent together
    expect(deps.sentTo).toContain('group@g.us');
    // Cursor set to last message timestamp
    expect(deps.cursors['group@g.us']).toBe('2024-01-01T00:00:02.000Z');
  });

  it('catches setTyping rejection without crashing the loop', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg]);

    const setTypingMock = vi.fn().mockRejectedValue(new Error('typing failed'));
    const deps = makeDeps({
      findChannel: () =>
        ({
          name: 'test',
          ownsJid: () => true,
          sendMessage: async () => {},
          setTyping: setTypingMock,
        }) as unknown as Channel,
    });
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    // setTyping was called and rejected, but the loop survived
    expect(setTypingMock).toHaveBeenCalledWith('group@g.us', true);
    expect(deps.sentTo).toContain('group@g.us');
  });

  it('skips groups not in registeredGroups', async () => {
    const msg = {
      id: '1',
      chat_jid: 'unknown@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });

    // The registered groups only contain group@g.us, not unknown@g.us
    const deps = makeDeps();
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toHaveLength(0);
    expect(deps.enqueued).toHaveLength(0);
  });

  it('enqueues without closeStdin when session command is not allowed', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: '@Andy /new',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockExtractSessionCommand.mockReturnValue('/new');
    mockIsSessionCommandAllowed.mockReturnValue(false);

    const deps = makeDeps();
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    // closeStdin should NOT be called when the command is not allowed
    expect(deps.closedStdin).toHaveLength(0);
    // But enqueue should still happen
    expect(deps.enqueued).toContain('group@g.us');
  });

  it('uses fallback groupMessages when getMessagesSince returns empty', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    // allPending is empty, so messagesToSend falls back to groupMessages
    mockGetMessagesSince.mockReturnValue([]);

    const deps = makeDeps();
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    // formatMessages should be called with the original groupMessages
    expect(mockFormatMessages).toHaveBeenCalledWith([msg], 'UTC');
    expect(deps.sentTo).toContain('group@g.us');
  });

  it('processes non-main group when trigger matches and sender is allowed', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: '@Andy do something',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg]);
    mockGetTriggerPattern.mockReturnValue(/^@Andy\b/i);
    mockIsTriggerAllowed.mockReturnValue(true);

    const deps = makeDeps({
      getRegisteredGroups: () => ({
        'group@g.us': {
          name: 'Team',
          folder: 'team',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          // isMain not set, requiresTrigger not set (defaults to needing trigger)
        },
      }),
    });
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toContain('group@g.us');
  });

  it('processes non-main group with requiresTrigger=false without trigger', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: 'hello no trigger',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetMessagesSince.mockReturnValue([msg]);

    const deps = makeDeps({
      getRegisteredGroups: () => ({
        'group@g.us': {
          name: 'Team',
          folder: 'team',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
          requiresTrigger: false,
        },
      }),
    });
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toContain('group@g.us');
  });

  it('skips non-main group when trigger matches but sender is not allowed (not from me)', async () => {
    const msg = {
      id: '1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      content: '@Andy do something',
      timestamp: '2024-01-01T00:00:01.000Z',
      is_from_me: false,
      sender_name: 'User',
    };

    mockGetNewMessages.mockReturnValueOnce({
      messages: [msg],
      newTimestamp: '2024-01-01T00:00:01.000Z',
    });
    mockGetTriggerPattern.mockReturnValue(/^@Andy\b/i);
    mockIsTriggerAllowed.mockReturnValue(false);

    const deps = makeDeps({
      getRegisteredGroups: () => ({
        'group@g.us': {
          name: 'Team',
          folder: 'team',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      }),
    });
    const { startMessagePollingLoop } = await import('./message-loop.js');

    const loopPromise = startMessagePollingLoop(deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.sentTo).toHaveLength(0);
  });
});
