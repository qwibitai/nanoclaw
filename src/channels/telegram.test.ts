import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ChannelOpts } from './registry.js';
import type { RegisteredGroup } from '../types.js';

// --- Mocks ---

// Mock telegraf module
const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 999 });
const mockDeleteMessage = vi.fn().mockResolvedValue(true);
const mockGetChat = vi.fn().mockResolvedValue({ title: 'Test Group' });
const mockLaunch = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn();
const mockOn = vi.fn();

vi.mock('telegraf', () => {
  class MockTelegraf {
    launch = mockLaunch;
    stop = mockStop;
    on = mockOn;
    botInfo = { id: 12345, username: 'x_bot', is_bot: true, first_name: 'X' };
    telegram = {
      sendMessage: mockSendMessage,
      deleteMessage: mockDeleteMessage,
      getChat: mockGetChat,
    };
    constructor(_token: string) {}
  }
  return { Telegraf: MockTelegraf };
});

// Mock env to control token presence
let mockToken: string | undefined = 'test-token-123';
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const result: Record<string, string> = {};
    if (keys.includes('TELEGRAM_BOT_TOKEN') && mockToken) {
      result.TELEGRAM_BOT_TOKEN = mockToken;
    }
    return result;
  }),
}));

vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'X',
  TRIGGER_PATTERN: /^@?X\b/i,
}));

// Import after mocks
import { createTelegramChannel } from './telegram.js';
import { updateChatName } from '../db.js';

function makeOpts(
  registeredGroups: Record<string, RegisteredGroup> = {},
): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => registeredGroups,
  };
}

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'test-group',
    folder: 'test',
    trigger: '^@?X\\b',
    added_at: new Date().toISOString(),
    requiresTrigger: true,
    ...overrides,
  };
}

// Helper to simulate an incoming message by calling the handler registered via bot.on
function getMessageHandler(): (ctx: unknown) => void {
  // mockOn is called with ('message', handler)
  const call = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'message');
  if (!call) throw new Error('No message handler registered');
  return call[1] as (ctx: unknown) => void;
}

function makeTelegramMessage(overrides: Record<string, unknown> = {}) {
  return {
    message_id: 42,
    date: Math.floor(Date.now() / 1000),
    text: 'Hello world',
    chat: { id: 100, type: 'private' as const },
    from: {
      id: 999,
      first_name: 'Alice',
      last_name: 'Smith',
      username: 'alice',
    },
    ...overrides,
  };
}

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToken = 'test-token-123';
  });

  describe('factory', () => {
    it('returns null when TELEGRAM_BOT_TOKEN is absent', () => {
      mockToken = undefined;
      const channel = createTelegramChannel(makeOpts());
      expect(channel).toBeNull();
    });

    it('returns a channel when token is present', () => {
      const channel = createTelegramChannel(makeOpts());
      expect(channel).not.toBeNull();
      expect(channel!.name).toBe('telegram');
    });
  });

  describe('ownsJid', () => {
    it('returns true for telegram: JIDs', () => {
      const channel = createTelegramChannel(makeOpts())!;
      expect(channel.ownsJid('telegram:123')).toBe(true);
    });

    it('returns false for non-telegram JIDs', () => {
      const channel = createTelegramChannel(makeOpts())!;
      expect(channel.ownsJid('slack:123')).toBe(false);
      expect(channel.ownsJid('whatsapp:123')).toBe(false);
    });
  });

  describe('connect and disconnect', () => {
    it('connects and sets connected=true', async () => {
      const channel = createTelegramChannel(makeOpts())!;
      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      expect(mockLaunch).toHaveBeenCalled();
    });

    it('disconnect sets connected=false', async () => {
      const channel = createTelegramChannel(makeOpts())!;
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(mockStop).toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('sends a message to the correct chat', async () => {
      const channel = createTelegramChannel(makeOpts())!;
      await channel.connect();
      await channel.sendMessage('telegram:100', 'Hello');
      expect(mockSendMessage).toHaveBeenCalledWith('100', 'Hello');
    });

    it('chunks messages longer than 4096 chars', async () => {
      const channel = createTelegramChannel(makeOpts())!;
      await channel.connect();
      const longText = 'A'.repeat(4096 + 100);
      await channel.sendMessage('telegram:100', longText);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
      expect(mockSendMessage.mock.calls[0][1]).toHaveLength(4096);
      expect(mockSendMessage.mock.calls[1][1]).toHaveLength(100);
    });
  });

  describe('outgoing queue', () => {
    it('queues messages when disconnected and flushes on connect', async () => {
      const channel = createTelegramChannel(makeOpts())!;
      // Send while disconnected
      await channel.sendMessage('telegram:100', 'queued msg');
      expect(mockSendMessage).not.toHaveBeenCalled();

      // Connect flushes
      await channel.connect();
      expect(mockSendMessage).toHaveBeenCalledWith('100', 'queued msg');
    });
  });

  describe('message handling - DM', () => {
    it('delivers DM messages for registered groups', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:100': makeGroup({ requiresTrigger: false }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      const msg = makeTelegramMessage();
      handler({ message: msg });

      expect(channelOpts.onChatMetadata).toHaveBeenCalledWith(
        'telegram:100',
        expect.any(String),
        undefined,
        'telegram',
        false,
      );
      expect(channelOpts.onMessage).toHaveBeenCalledWith(
        'telegram:100',
        expect.objectContaining({
          id: '42',
          chat_jid: 'telegram:100',
          sender: 'alice',
          sender_name: 'Alice Smith',
          content: 'Hello world',
          is_from_me: false,
        }),
      );
    });

    it('does not deliver messages for unregistered chats', () => {
      const channelOpts = makeOpts({}); // no registered groups
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      handler({ message: makeTelegramMessage() });

      expect(channelOpts.onChatMetadata).toHaveBeenCalled();
      expect(channelOpts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('message handling - group', () => {
    it('delivers group messages for registered groups', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:-200': makeGroup({ requiresTrigger: true }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      const msg = makeTelegramMessage({
        chat: { id: -200, type: 'supergroup', title: 'Dev Group' },
        text: '@X hello there',
      });
      handler({ message: msg });

      expect(channelOpts.onChatMetadata).toHaveBeenCalledWith(
        'telegram:-200',
        expect.any(String),
        'Dev Group',
        'telegram',
        true,
      );
      expect(channelOpts.onMessage).toHaveBeenCalled();
    });

    it('still calls onMessage for non-trigger messages (for storage) but without trigger', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:-200': makeGroup({ requiresTrigger: true }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      const msg = makeTelegramMessage({
        chat: { id: -200, type: 'group', title: 'Dev Group' },
        text: 'just chatting',
      });
      handler({ message: msg });

      // onMessage is still called for storage
      expect(channelOpts.onMessage).toHaveBeenCalled();
    });
  });

  describe('trigger pattern', () => {
    it('messages without trigger do not get thinking indicator when requiresTrigger=true', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:-200': makeGroup({ requiresTrigger: true }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      const msg = makeTelegramMessage({
        chat: { id: -200, type: 'group', title: 'Dev Group' },
        text: 'no trigger here',
      });
      handler({ message: msg });

      // No thinking indicator sent for non-trigger messages
      // (sendMessage for thinking is only called for trigger matches)
      // The message handler returns early after onMessage for non-trigger
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('@botusername mention translation', () => {
    it('translates @x_bot to @X', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:-200': makeGroup({ requiresTrigger: false }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      const msg = makeTelegramMessage({
        chat: { id: -200, type: 'group', title: 'Dev Group' },
        text: '@x_bot hello there',
      });
      handler({ message: msg });

      const call = (channelOpts.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call[1].content).toMatch(/^@X/);
    });
  });

  describe('/x command handling', () => {
    it('translates /x hello to @X hello', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:100': makeGroup({ requiresTrigger: false }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      const msg = makeTelegramMessage({ text: '/x hello' });
      handler({ message: msg });

      const call = (channelOpts.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call[1].content).toBe('@X hello');
    });

    it('handles bare /x command', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:100': makeGroup({ requiresTrigger: false }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      const msg = makeTelegramMessage({ text: '/x' });
      handler({ message: msg });

      const call = (channelOpts.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call[1].content).toBe('@X');
    });
  });

  describe('self-message detection', () => {
    it('marks messages from bot as is_from_me', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:100': makeGroup({ requiresTrigger: false }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      const msg = makeTelegramMessage({
        from: { id: 12345, first_name: 'X', username: 'x_bot' },
      });
      handler({ message: msg });

      const call = (channelOpts.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call[1].is_from_me).toBe(true);
      expect(call[1].is_bot_message).toBe(true);
    });
  });

  describe('thinking indicator', () => {
    it('sends thinking message on setTyping(true) and deletes on setTyping(false)', async () => {
      const channel = createTelegramChannel(makeOpts())!;
      await channel.connect();

      await channel.setTyping!('telegram:100', true);
      expect(mockSendMessage).toHaveBeenCalledWith(
        '100',
        '\u{1F9E0} Thinking...',
      );

      await channel.setTyping!('telegram:100', false);
      expect(mockDeleteMessage).toHaveBeenCalledWith('100', 999);
    });
  });

  describe('metadata sync', () => {
    it('syncs group metadata on connect', async () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:-200': makeGroup(),
      };
      const channel = createTelegramChannel(makeOpts(groups))!;
      await channel.connect();

      expect(mockGetChat).toHaveBeenCalledWith('-200');
      expect(updateChatName).toHaveBeenCalledWith(
        'telegram:-200',
        'Test Group',
      );
    });

    it('skips non-telegram JIDs during sync', async () => {
      const groups: Record<string, RegisteredGroup> = {
        'slack:C123': makeGroup(),
      };
      const channel = createTelegramChannel(makeOpts(groups))!;
      await channel.connect();

      expect(mockGetChat).not.toHaveBeenCalled();
    });
  });

  describe('non-text messages', () => {
    it('ignores messages without text', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:100': makeGroup({ requiresTrigger: false }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      // Message without text (e.g., photo)
      handler({
        message: {
          message_id: 42,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 100, type: 'private' },
          from: { id: 999, first_name: 'Alice' },
          photo: [{ file_id: 'abc' }],
        },
      });

      expect(channelOpts.onMessage).not.toHaveBeenCalled();
      expect(channelOpts.onChatMetadata).not.toHaveBeenCalled();
    });
  });

  describe('sender name resolution', () => {
    it('uses first_name + last_name when both available', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:100': makeGroup({ requiresTrigger: false }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      handler({
        message: makeTelegramMessage({
          from: {
            id: 999,
            first_name: 'Alice',
            last_name: 'Smith',
            username: 'alice',
          },
        }),
      });

      const call = (channelOpts.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call[1].sender_name).toBe('Alice Smith');
    });

    it('uses first_name only when no last_name', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:100': makeGroup({ requiresTrigger: false }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      handler({
        message: makeTelegramMessage({
          from: { id: 999, first_name: 'Bob' },
        }),
      });

      const call = (channelOpts.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call[1].sender_name).toBe('Bob');
    });

    it('falls back to username when no first_name', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:100': makeGroup({ requiresTrigger: false }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      handler({
        message: makeTelegramMessage({
          from: { id: 999, username: 'cooluser' },
        }),
      });

      const call = (channelOpts.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call[1].sender_name).toBe('cooluser');
    });

    it('falls back to numeric id when nothing else available', () => {
      const groups: Record<string, RegisteredGroup> = {
        'telegram:100': makeGroup({ requiresTrigger: false }),
      };
      const channelOpts = makeOpts(groups);
      createTelegramChannel(channelOpts);

      const handler = getMessageHandler();
      handler({
        message: makeTelegramMessage({
          from: { id: 777 },
        }),
      });

      const call = (channelOpts.onMessage as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call[1].sender_name).toBe('777');
    });
  });
});
