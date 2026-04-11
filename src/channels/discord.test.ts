import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
  DISCORD_REACTIONS_INBOUND: 'all',
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- discord.js mock ---

type Handler = (...args: any[]) => any;

const clientRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('discord.js', () => {
  const Events = {
    MessageCreate: 'messageCreate',
    ClientReady: 'ready',
    Error: 'error',
    InteractionCreate: 'interactionCreate',
    MessageReactionAdd: 'messageReactionAdd',
    MessageReactionRemove: 'messageReactionRemove',
  };

  const GatewayIntentBits = {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
    DirectMessages: 8,
    GuildMessageReactions: 16,
    DirectMessageReactions: 32,
  };

  const Partials = {
    Channel: 'Channel',
    Message: 'Message',
    User: 'User',
    GuildMember: 'GuildMember',
    Reaction: 'Reaction',
  };

  class SlashCommandBuilder {
    private data: any = {};
    setName(n: string) {
      this.data.name = n;
      return this;
    }
    setDescription(d: string) {
      this.data.description = d;
      return this;
    }
    toJSON() {
      return this.data;
    }
  }

  class MockClient {
    eventHandlers = new Map<string, Handler[]>();
    user: any = { id: '999888777', tag: 'Andy#1234' };
    application: any = {
      commands: { set: vi.fn().mockResolvedValue([]) },
    };
    private _ready = false;

    constructor(_opts: any) {
      clientRef.current = this;
    }

    on(event: string, handler: Handler) {
      const existing = this.eventHandlers.get(event) || [];
      existing.push(handler);
      this.eventHandlers.set(event, existing);
      return this;
    }

    once(event: string, handler: Handler) {
      return this.on(event, handler);
    }

    async login(_token: string) {
      this._ready = true;
      // Fire the ready event — handler expects a readyClient with
      // `user`, `application.commands.set()`, and `channels.fetch()`
      const readyHandlers = this.eventHandlers.get('ready') || [];
      for (const h of readyHandlers) {
        await h({
          user: this.user,
          application: this.application,
          channels: this.channels,
        });
      }
    }

    isReady() {
      return this._ready;
    }

    mockWebhook = {
      send: vi.fn().mockResolvedValue({ id: 'webhook-msg-1' }),
      name: 'NanoClaw Pets',
      owner: { id: '999888777' },
    };

    _mockChannel = {
      send: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      fetchWebhooks: vi.fn().mockResolvedValue({
        find: vi.fn((fn: any) => {
          // Simulate Collection.find() — test the predicate against our mock
          return fn(clientRef.current!.mockWebhook)
            ? clientRef.current!.mockWebhook
            : undefined;
        }),
      }),
      createWebhook: vi.fn().mockResolvedValue(null), // only called if find returns undefined
    };

    channels = {
      fetch: vi.fn().mockResolvedValue(this._mockChannel),
    };

    destroy() {
      this._ready = false;
    }
  }

  // Mock TextChannel type
  class TextChannel {}
  class Webhook {}

  return {
    Client: MockClient,
    Events,
    GatewayIntentBits,
    Partials,
    SlashCommandBuilder,
    TextChannel,
    Webhook,
  };
});

import { DiscordChannel, DiscordChannelOpts } from './discord.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<DiscordChannelOpts>,
): DiscordChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'dc:1234567890123456': {
        name: 'Test Server #general',
        folder: 'test-server',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createMessage(overrides: {
  channelId?: string;
  content?: string;
  authorId?: string;
  authorUsername?: string;
  authorDisplayName?: string;
  memberDisplayName?: string;
  isBot?: boolean;
  guildName?: string;
  channelName?: string;
  messageId?: string;
  createdAt?: Date;
  attachments?: Map<string, any>;
  reference?: { messageId?: string };
  mentionsBotId?: boolean;
}) {
  const channelId = overrides.channelId ?? '1234567890123456';
  const authorId = overrides.authorId ?? '55512345';
  const botId = '999888777'; // matches mock client user id

  const mentionsMap = new Map();
  if (overrides.mentionsBotId) {
    mentionsMap.set(botId, { id: botId });
  }

  return {
    channelId,
    id: overrides.messageId ?? 'msg_001',
    content: overrides.content ?? 'Hello everyone',
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
    author: {
      id: authorId,
      username: overrides.authorUsername ?? 'alice',
      displayName: overrides.authorDisplayName ?? 'Alice',
      bot: overrides.isBot ?? false,
    },
    member: overrides.memberDisplayName
      ? { displayName: overrides.memberDisplayName }
      : null,
    guild: overrides.guildName ? { name: overrides.guildName } : null,
    channel: {
      name: overrides.channelName ?? 'general',
      messages: {
        fetch: vi.fn().mockResolvedValue({
          author: { username: 'Bob', displayName: 'Bob' },
          member: { displayName: 'Bob' },
        }),
      },
    },
    mentions: {
      users: mentionsMap,
    },
    attachments: overrides.attachments ?? new Map(),
    reference: overrides.reference ?? null,
  };
}

function currentClient() {
  return clientRef.current;
}

async function triggerMessage(message: any) {
  const handlers = currentClient().eventHandlers.get('messageCreate') || [];
  for (const h of handlers) await h(message);
}

async function triggerReaction(
  action: 'add' | 'remove',
  reaction: any,
  user: any,
) {
  const ev = action === 'add' ? 'messageReactionAdd' : 'messageReactionRemove';
  const handlers = currentClient().eventHandlers.get(ev) || [];
  for (const h of handlers) await h(reaction, user);
}

function createReaction(overrides: {
  messageId?: string;
  channelId?: string;
  emojiName?: string | null;
  emojiId?: string | null;
  authorId?: string;
  content?: string;
}) {
  return {
    partial: false,
    emoji: {
      name: overrides.emojiName ?? '👍',
      id: overrides.emojiId ?? null,
    },
    message: {
      partial: false,
      id: overrides.messageId ?? 'msg_xyz',
      channelId: overrides.channelId ?? '1234567890123456',
      content: overrides.content ?? 'hello there',
      author: { id: overrides.authorId ?? '55512345' },
    },
    async fetch() {
      return this;
    },
  };
}

// --- Tests ---

describe('DiscordChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when client is ready', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();

      expect(currentClient().eventHandlers.has('messageCreate')).toBe(true);
      expect(currentClient().eventHandlers.has('error')).toBe(true);
      expect(currentClient().eventHandlers.has('ready')).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello everyone',
        guildName: 'Test Server',
        channelName: 'general',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Test Server #general',
        'discord',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          id: 'msg_001',
          chat_jid: 'dc:1234567890123456',
          sender: '55512345',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered channels', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        channelId: '9999999999999999',
        content: 'Unknown channel',
        guildName: 'Other Server',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:9999999999999999',
        expect.any(String),
        expect.any(String),
        'discord',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores bot messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({ isBot: true, content: 'I am a bot' });
      await triggerMessage(msg);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('uses member displayName when available (server nickname)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: 'Alice Nickname',
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Nickname' }),
      );
    });

    it('falls back to author displayName when no member', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hi',
        memberDisplayName: undefined,
        authorDisplayName: 'Alice Global',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({ sender_name: 'Alice Global' }),
      );
    });

    it('uses sender name for DM chats (no guild)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:1234567890123456': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: undefined,
        authorDisplayName: 'Alice',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'Alice',
        'discord',
        false,
      );
    });

    it('uses guild name + channel name for server messages', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'Hello',
        guildName: 'My Server',
        channelName: 'bot-chat',
      });
      await triggerMessage(msg);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.any(String),
        'My Server #bot-chat',
        'discord',
        true,
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates <@botId> mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@999888777> what time is it?',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '@Andy hello <@999888777>',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      // Should NOT prepend @Andy — already starts with trigger
      // But the <@botId> should still be stripped
      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy hello',
        }),
      );
    });

    it('does not translate when bot is not mentioned', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'hello everyone',
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'hello everyone',
        }),
      );
    });

    it('handles <@!botId> (nickname mention format)', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: '<@!999888777> check this',
        mentionsBotId: true,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '@Andy check this',
        }),
      );
    });
  });

  // --- Attachments ---

  describe('attachments', () => {
    it('stores image attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'photo.png', contentType: 'image/png' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Image: photo.png]',
        }),
      );
    });

    it('stores video attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'clip.mp4', contentType: 'video/mp4' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Video: clip.mp4]',
        }),
      );
    });

    it('stores file attachment with placeholder', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'report.pdf', contentType: 'application/pdf' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[File: report.pdf]',
        }),
      );
    });

    it('includes text content with attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'photo.jpg', contentType: 'image/jpeg' }],
      ]);
      const msg = createMessage({
        content: 'Check this out',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: 'Check this out\n[Image: photo.jpg]',
        }),
      );
    });

    it('handles multiple attachments', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['att1', { name: 'a.png', contentType: 'image/png' }],
        ['att2', { name: 'b.txt', contentType: 'text/plain' }],
      ]);
      const msg = createMessage({
        content: '',
        attachments,
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Image: a.png]\n[File: b.txt]',
        }),
      );
    });
  });

  // --- Reply context ---

  describe('reply context', () => {
    it('includes reply author in content', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'I agree with that',
        reference: { messageId: 'original_msg_id' },
        guildName: 'Server',
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: '[Reply to Bob] I agree with that',
        }),
      );
    });

    it('includes a snippet of the replied-to message when present', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const msg = createMessage({
        content: 'yes please',
        reference: { messageId: 'original_msg_id' },
        guildName: 'Server',
      });
      msg.channel.messages.fetch = vi.fn().mockResolvedValue({
        author: { username: 'Bob', displayName: 'Bob' },
        member: { displayName: 'Bob' },
        content: "what's the weather?",
      });
      await triggerMessage(msg);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:1234567890123456',
        expect.objectContaining({
          content: `[Reply to Bob "what's the weather?"] yes please`,
        }),
      );
    });

    it('truncates long replied-to message snippets', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const long = 'x'.repeat(300);
      const msg = createMessage({
        content: 'ok',
        reference: { messageId: 'original_msg_id' },
        guildName: 'Server',
      });
      msg.channel.messages.fetch = vi.fn().mockResolvedValue({
        author: { username: 'Bob', displayName: 'Bob' },
        member: { displayName: 'Bob' },
        content: long,
      });
      await triggerMessage(msg);

      const call = (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[1].content).toBe(`[Reply to Bob "${'x'.repeat(200)}…"] ok`);
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via channel', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:1234567890123456', 'Hello');

      const fetchedChannel =
        await currentClient().channels.fetch('1234567890123456');
      expect(currentClient().channels.fetch).toHaveBeenCalledWith(
        '1234567890123456',
      );
    });

    it('strips dc: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('dc:9876543210', 'Test');

      expect(currentClient().channels.fetch).toHaveBeenCalledWith('9876543210');
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      currentClient().channels.fetch.mockRejectedValueOnce(
        new Error('Channel not found'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('dc:1234567890123456', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect — client is null
      await channel.sendMessage('dc:1234567890123456', 'No client');

      // No error, no API call
    });

    it('splits messages exceeding 2000 characters', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn(),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      const longText = 'x'.repeat(3000);
      await channel.sendMessage('dc:1234567890123456', longText);

      expect(mockChannel.send).toHaveBeenCalledTimes(2);
      expect(mockChannel.send).toHaveBeenNthCalledWith(1, 'x'.repeat(2000));
      expect(mockChannel.send).toHaveBeenNthCalledWith(2, 'x'.repeat(1000));
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns dc: JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('dc:1234567890123456')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing indicator when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const mockChannel = {
        send: vi.fn(),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      };
      currentClient().channels.fetch.mockResolvedValue(mockChannel);

      await channel.setTyping('dc:1234567890123456', true);

      expect(mockChannel.sendTyping).toHaveBeenCalled();
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('dc:1234567890123456', false);

      // channels.fetch should NOT be called
      expect(currentClient().channels.fetch).not.toHaveBeenCalled();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('dc:1234567890123456', true);

      // No error
    });
  });

  // --- Reactions (inbound) ---

  describe('inbound reactions', () => {
    it('forwards a unicode reaction on a registered channel', async () => {
      const onReaction = vi.fn();
      const channel = new DiscordChannel(
        'test-token',
        createTestOpts({ onReaction }),
      );
      await channel.connect();

      await triggerReaction('add', createReaction({ emojiName: '🎉' }), {
        id: 'user_1',
        username: 'alice',
        globalName: 'Alice',
        bot: false,
      });

      expect(onReaction).toHaveBeenCalledTimes(1);
      const [chatJid, event] = onReaction.mock.calls[0];
      expect(chatJid).toBe('dc:1234567890123456');
      expect(event).toMatchObject({
        emoji: '🎉',
        action: 'add',
        user_id: 'user_1',
        user_name: 'Alice',
        on_bot_message: false,
      });
    });

    it('fires on remove events', async () => {
      const onReaction = vi.fn();
      const channel = new DiscordChannel(
        'test-token',
        createTestOpts({ onReaction }),
      );
      await channel.connect();

      await triggerReaction('remove', createReaction({ emojiName: '👍' }), {
        id: 'user_2',
        username: 'bob',
        globalName: 'Bob',
        bot: false,
      });

      expect(onReaction).toHaveBeenCalledTimes(1);
      expect(onReaction.mock.calls[0][1].action).toBe('remove');
    });

    it('drops reactions from bots', async () => {
      const onReaction = vi.fn();
      const channel = new DiscordChannel(
        'test-token',
        createTestOpts({ onReaction }),
      );
      await channel.connect();

      await triggerReaction('add', createReaction({}), {
        id: 'other_bot',
        username: 'somebot',
        bot: true,
      });

      expect(onReaction).not.toHaveBeenCalled();
    });

    it("drops reactions from the bot's own user id", async () => {
      const onReaction = vi.fn();
      const channel = new DiscordChannel(
        'test-token',
        createTestOpts({ onReaction }),
      );
      await channel.connect();

      await triggerReaction('add', createReaction({}), {
        id: '999888777',
        username: 'andy',
        bot: false,
      });

      expect(onReaction).not.toHaveBeenCalled();
    });

    it('drops custom guild emoji (v1 unicode only)', async () => {
      const onReaction = vi.fn();
      const channel = new DiscordChannel(
        'test-token',
        createTestOpts({ onReaction }),
      );
      await channel.connect();

      await triggerReaction(
        'add',
        createReaction({ emojiName: 'party_parrot', emojiId: '12345' }),
        { id: 'user_3', username: 'alice', bot: false },
      );

      expect(onReaction).not.toHaveBeenCalled();
    });

    it('drops reactions in unregistered channels', async () => {
      const onReaction = vi.fn();
      const channel = new DiscordChannel(
        'test-token',
        createTestOpts({ onReaction }),
      );
      await channel.connect();

      await triggerReaction(
        'add',
        createReaction({ channelId: 'unknown_channel' }),
        { id: 'user_4', username: 'alice', bot: false },
      );

      expect(onReaction).not.toHaveBeenCalled();
    });
  });

  // --- Reactions (outbound) ---

  describe('outbound reactions', () => {
    it('addReaction fetches message and calls react()', async () => {
      const react = vi.fn().mockResolvedValue(undefined);
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      currentClient().channels.fetch = vi.fn().mockResolvedValue({
        messages: {
          fetch: vi.fn().mockResolvedValue({ react }),
        },
      });

      await channel.addReaction('dc:1234567890123456', 'msg_abc', '👍');
      expect(react).toHaveBeenCalledWith('👍');
    });

    it("removeReaction removes the bot's own reaction", async () => {
      const remove = vi.fn().mockResolvedValue(undefined);
      const resolve = vi.fn().mockReturnValue({ users: { remove } });
      const opts = createTestOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      currentClient().channels.fetch = vi.fn().mockResolvedValue({
        messages: {
          fetch: vi.fn().mockResolvedValue({ reactions: { resolve } }),
        },
      });

      await channel.removeReaction('dc:1234567890123456', 'msg_abc', '👍');
      expect(resolve).toHaveBeenCalledWith('👍');
      expect(remove).toHaveBeenCalledWith('999888777');
    });
  });

  // --- DM handling (unified path) ---

  describe('DM handling', () => {
    function dmOpts(overrides?: Partial<DiscordChannelOpts>) {
      return createTestOpts({
        registeredGroups: vi.fn(() => ({
          'dc:9999999999999999': {
            name: 'DM: Alice',
            folder: 'discord_dms_alice',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
            isDm: true,
          },
        })),
        ...overrides,
      });
    }

    function dmMessage(overrides?: Parameters<typeof createMessage>[0]) {
      return createMessage({
        channelId: '9999999999999999',
        guildName: undefined,
        authorDisplayName: 'Alice',
        ...overrides,
      });
    }

    it('auto-prepends trigger for DM messages', async () => {
      const opts = dmOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await triggerMessage(dmMessage({ content: 'hello' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:9999999999999999',
        expect.objectContaining({ content: '@Andy hello' }),
      );
    });

    it('does not double-prepend trigger for DMs', async () => {
      const opts = dmOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await triggerMessage(dmMessage({ content: '@Andy hello' }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:9999999999999999',
        expect.objectContaining({ content: '@Andy hello' }),
      );
    });

    it('strips bot mention and prepends trigger in DMs', async () => {
      const opts = dmOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await triggerMessage(
        dmMessage({ content: '<@999888777> check this', mentionsBotId: true }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:9999999999999999',
        expect.objectContaining({ content: '@Andy check this' }),
      );
    });

    it('includes attachments in DM messages', async () => {
      const opts = dmOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      const attachments = new Map([
        ['1', { name: 'photo.png', contentType: 'image/png' }],
      ]);
      await triggerMessage(dmMessage({ content: 'look', attachments }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:9999999999999999',
        expect.objectContaining({
          content: expect.stringContaining('[Image: photo.png]'),
        }),
      );
    });

    it('includes reply context in DM messages', async () => {
      const opts = dmOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      await triggerMessage(
        dmMessage({
          content: 'yes exactly',
          reference: { messageId: 'msg_ref_123' },
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'dc:9999999999999999',
        expect.objectContaining({
          content: expect.stringContaining('[Reply to Bob'),
        }),
      );
    });

    it('does not register a raw packet handler', async () => {
      const opts = dmOpts();
      const channel = new DiscordChannel('test-token', opts);
      await channel.connect();

      expect(currentClient().eventHandlers.has('raw')).toBe(false);
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "discord"', () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      expect(channel.name).toBe('discord');
    });
  });

  // --- Webhook messages ---

  describe('sendWebhookMessage', () => {
    it('sends via webhook with custom username', async () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      await channel.connect();

      const id = await channel.sendWebhookMessage(
        'dc:1234567890123456',
        'test message',
        'Voss 🌋',
      );

      expect(currentClient().mockWebhook.send).toHaveBeenCalledWith({
        content: 'test message',
        username: 'Voss 🌋',
        avatarURL: undefined,
      });
      expect(id).toBe('webhook-msg-1');
    });

    it('creates webhook when none exist', async () => {
      const channel = new DiscordChannel('test-token', createTestOpts());
      await channel.connect();

      // Override fetchWebhooks to return collection where find() returns undefined
      const mockCh = currentClient()._mockChannel;
      const newWebhook = {
        send: vi.fn().mockResolvedValue({ id: 'new-wh-msg' }),
        name: 'NanoClaw Pets',
        owner: { id: '999888777' },
      };
      mockCh.fetchWebhooks.mockResolvedValueOnce({
        find: vi.fn(() => undefined),
      });
      mockCh.createWebhook.mockResolvedValueOnce(newWebhook);

      const id = await channel.sendWebhookMessage(
        'dc:1234567890123456',
        'hello',
        'Nyx 🌙',
      );

      expect(mockCh.createWebhook).toHaveBeenCalledWith({
        name: 'NanoClaw Pets',
      });
      expect(newWebhook.send).toHaveBeenCalled();
      expect(id).toBe('new-wh-msg');
    });
  });
});
