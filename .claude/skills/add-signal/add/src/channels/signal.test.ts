import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { SignalChannel, SignalChannelOpts, resolveMentions } from './signal.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SignalChannelOpts>,
): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'sig:+1234567890': {
        name: 'Signal DM',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'sig:g:testGroupId==': {
        name: 'Signal Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createEnvelope(overrides: {
  source?: string;
  sourceName?: string;
  timestamp?: number;
  message?: string;
  groupId?: string;
  groupName?: string;
  attachments?: Array<{ contentType?: string; filename?: string; id?: string }>;
  quote?: { author?: string; authorName?: string };
  mentions?: Array<Record<string, unknown>>;
}) {
  const envelope: Record<string, any> = {
    source: overrides.source ?? '+1234567890',
    sourceName: overrides.sourceName ?? 'Alice',
    timestamp: overrides.timestamp ?? 1704067200000,
    dataMessage: {
      timestamp: overrides.timestamp ?? 1704067200000,
      message: overrides.message ?? 'Hello from Signal',
    },
  };

  if (overrides.groupId) {
    const groupInfo: Record<string, any> = {
      groupId: overrides.groupId,
      type: 'DELIVER',
    };
    if (overrides.groupName !== undefined) {
      groupInfo.groupName = overrides.groupName;
    }
    envelope.dataMessage.groupInfo = groupInfo;
  }

  if (overrides.attachments) {
    envelope.dataMessage.attachments = overrides.attachments;
  }

  if (overrides.quote) {
    envelope.dataMessage.quote = overrides.quote;
  }

  if (overrides.mentions) {
    envelope.dataMessage.mentions = overrides.mentions;
  }

  return { envelope };
}

function createSyncEnvelope(overrides: {
  sourceName?: string;
  timestamp?: number;
  message?: string;
  destination?: string;
  groupId?: string;
  groupName?: string;
  mentions?: Array<Record<string, unknown>>;
}) {
  const envelope: Record<string, any> = {
    source: '+9999999999',
    sourceName: overrides.sourceName ?? 'Me',
    timestamp: overrides.timestamp ?? 1704067200000,
    syncMessage: {
      sentMessage: {
        timestamp: overrides.timestamp ?? 1704067200000,
        message: overrides.message ?? 'Sync message',
        destination: overrides.destination,
      },
    },
  };

  if (overrides.groupId) {
    envelope.syncMessage.sentMessage.groupInfo = {
      groupId: overrides.groupId,
      groupName: overrides.groupName,
    };
  }

  if (overrides.mentions) {
    envelope.syncMessage.sentMessage.mentions = overrides.mentions;
  }

  return { envelope };
}

// --- Tests ---

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns sig: JIDs (1:1)', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      expect(channel.ownsJid('sig:+1234567890')).toBe(true);
    });

    it('owns sig:g: JIDs (group)', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      expect(channel.ownsJid('sig:g:ABC123==')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own Discord JIDs', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      expect(channel.ownsJid('dc:1234567890')).toBe(false);
    });
  });

  // --- handleEnvelope (message handling) ---

  describe('handleEnvelope', () => {
    it('delivers 1:1 message for registered chat', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createEnvelope({
        source: '+1234567890',
        sourceName: 'Alice',
        message: 'Hello',
      }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sig:+1234567890',
        expect.any(String),
        'Alice',
        'signal',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+1234567890',
        expect.objectContaining({
          chat_jid: 'sig:+1234567890',
          sender: '+1234567890',
          sender_name: 'Alice',
          content: 'Hello',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('delivers group message for registered group', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createEnvelope({
        source: '+5555555555',
        sourceName: 'Bob',
        message: 'Group hello',
        groupId: 'testGroupId==',
        groupName: 'Signal Group',
      }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sig:g:testGroupId==',
        expect.any(String),
        'Signal Group',
        'signal',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:g:testGroupId==',
        expect.objectContaining({
          chat_jid: 'sig:g:testGroupId==',
          sender: '+5555555555',
          sender_name: 'Bob',
          content: 'Group hello',
        }),
      );
    });

    it('only emits metadata for unregistered chats', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createEnvelope({
        source: '+9876543210',
        sourceName: 'Unknown',
        message: 'Hi',
      }));

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores envelopes without dataMessage or syncMessage', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope({ envelope: { source: '+1234567890', timestamp: 123 } });

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('marks own messages with is_from_me and is_bot_message', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      // Register the own-number JID
      (opts.registeredGroups as ReturnType<typeof vi.fn>).mockReturnValue({
        'sig:+9999999999': {
          name: 'Self',
          folder: 'main',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });

      channel.handleEnvelope(createEnvelope({
        source: '+9999999999',
        message: 'My own message',
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+9999999999',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('falls back to sender phone when sourceName missing', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope({
        envelope: {
          source: '+1234567890',
          timestamp: 1704067200000,
          dataMessage: { message: 'No name', timestamp: 1704067200000 },
        },
      });

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sig:+1234567890',
        expect.any(String),
        '+1234567890',
        'signal',
        false,
      );
    });

    it('uses "Signal Group" as fallback group name', () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'sig:g:noNameGroup': {
            name: 'Group',
            folder: 'test',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createEnvelope({
        source: '+5555555555',
        message: 'Hi',
        groupId: 'noNameGroup',
        groupName: undefined,
      }));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sig:g:noNameGroup',
        expect.any(String),
        'Signal Group',
        'signal',
        true,
      );
    });
  });

  // --- Sync messages ---

  describe('syncMessage handling', () => {
    it('delivers sync message as bot message', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createSyncEnvelope({
        message: 'Sent from phone',
        destination: '+1234567890',
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+1234567890',
        expect.objectContaining({
          chat_jid: 'sig:+1234567890',
          content: 'Sent from phone',
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });

    it('treats Note-to-Self as user input (not bot message)', () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'sig:+9999999999': {
            name: 'Note to Self',
            folder: 'main',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createSyncEnvelope({
        message: 'Remind me to buy milk',
        destination: '+9999999999',
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+9999999999',
        expect.objectContaining({
          content: 'Remind me to buy milk',
          is_from_me: true,
          is_bot_message: false,
        }),
      );
    });

    it('delivers sync group message', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createSyncEnvelope({
        message: 'Group sync',
        groupId: 'testGroupId==',
        groupName: 'Signal Group',
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:g:testGroupId==',
        expect.objectContaining({
          chat_jid: 'sig:g:testGroupId==',
          content: 'Group sync',
          is_from_me: true,
          is_bot_message: true,
        }),
      );
    });
  });

  // --- /chatid command ---

  describe('/chatid command', () => {
    it('responds with chat JID and suppresses normal delivery', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);
      const sendSpy = vi.spyOn(channel, 'sendMessage').mockResolvedValue();

      channel.handleEnvelope(createEnvelope({
        source: '+1234567890',
        message: '/chatid',
      }));

      expect(sendSpy).toHaveBeenCalledWith('sig:+1234567890', 'Chat ID: sig:+1234567890');
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('is case-insensitive', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);
      const sendSpy = vi.spyOn(channel, 'sendMessage').mockResolvedValue();

      channel.handleEnvelope(createEnvelope({
        source: '+1234567890',
        message: '/ChatID',
      }));

      expect(sendSpy).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('works for group chats', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);
      const sendSpy = vi.spyOn(channel, 'sendMessage').mockResolvedValue();

      channel.handleEnvelope(createEnvelope({
        source: '+5555555555',
        message: '/chatid',
        groupId: 'testGroupId==',
      }));

      expect(sendSpy).toHaveBeenCalledWith('sig:g:testGroupId==', 'Chat ID: sig:g:testGroupId==');
    });
  });

  // --- Mention resolution ---

  describe('resolveMentions', () => {
    it('returns text unchanged when no mentions', () => {
      expect(resolveMentions('Hello world', undefined, '+999', 'Andy')).toBe('Hello world');
      expect(resolveMentions('Hello world', [], '+999', 'Andy')).toBe('Hello world');
    });

    it('returns undefined for undefined text', () => {
      expect(resolveMentions(undefined, [], '+999', 'Andy')).toBeUndefined();
    });

    it('replaces U+FFFC placeholder with @name', () => {
      const text = 'Hey \uFFFC check this';
      const mentions = [{ start: 4, length: 1, name: 'Bob', number: '+111' }];
      expect(resolveMentions(text, mentions, '+999', 'Andy')).toBe('Hey @Bob check this');
    });

    it('maps bot phone number mentions to assistant name', () => {
      const text = '\uFFFC hello';
      const mentions = [{ start: 0, length: 1, name: 'Bot', number: '+9999999999' }];
      expect(resolveMentions(text, mentions, '+9999999999', 'Andy')).toBe('@Andy hello');
    });

    it('handles multiple mentions sorted correctly', () => {
      const text = '\uFFFC and \uFFFC';
      const mentions = [
        { start: 0, length: 1, name: 'Alice', number: '+111' },
        { start: 6, length: 1, name: 'Bob', number: '+222' },
      ];
      expect(resolveMentions(text, mentions, '+999', 'Andy')).toBe('@Alice and @Bob');
    });

    it('resolves mentions in handleEnvelope', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createEnvelope({
        source: '+1234567890',
        message: '\uFFFC check this out',
        mentions: [{ start: 0, length: 1, name: 'Andy', number: '+9999999999' }],
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+1234567890',
        expect.objectContaining({ content: '@Andy check this out' }),
      );
    });
  });

  // --- Attachments ---

  describe('attachments', () => {
    it('stores image attachment with placeholder', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createEnvelope({
        message: '',
        attachments: [{ contentType: 'image/jpeg', filename: 'photo.jpg' }],
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+1234567890',
        expect.objectContaining({ content: '[Image: photo.jpg]' }),
      );
    });

    it('stores video attachment with placeholder', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createEnvelope({
        message: '',
        attachments: [{ contentType: 'video/mp4', filename: 'clip.mp4' }],
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+1234567890',
        expect.objectContaining({ content: '[Video: clip.mp4]' }),
      );
    });

    it('stores audio attachment with placeholder', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createEnvelope({
        message: '',
        attachments: [{ contentType: 'audio/ogg', filename: 'voice.ogg' }],
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+1234567890',
        expect.objectContaining({ content: '[Audio: voice.ogg]' }),
      );
    });

    it('includes text with attachments', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createEnvelope({
        message: 'Check this',
        attachments: [{ contentType: 'image/png', filename: 'img.png' }],
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+1234567890',
        expect.objectContaining({ content: 'Check this\n[Image: img.png]' }),
      );
    });

    it('handles multiple attachments', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createEnvelope({
        message: '',
        attachments: [
          { contentType: 'image/png', filename: 'a.png' },
          { contentType: 'application/pdf', filename: 'doc.pdf' },
        ],
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+1234567890',
        expect.objectContaining({ content: '[Image: a.png]\n[File: doc.pdf]' }),
      );
    });
  });

  // --- Reply/quote context ---

  describe('reply context', () => {
    it('includes quote author in content', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createEnvelope({
        message: 'I agree',
        quote: { authorName: 'Bob' },
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+1234567890',
        expect.objectContaining({ content: '[Reply to Bob] I agree' }),
      );
    });

    it('falls back to quote author phone number', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583', opts);

      channel.handleEnvelope(createEnvelope({
        message: 'Yes',
        quote: { author: '+5555555555' },
      }));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+1234567890',
        expect.objectContaining({ content: '[Reply to +5555555555] Yes' }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends 1:1 message via JSON-RPC over TCP', async () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      (channel as any).connected = true;
      (channel as any).socket = { write: vi.fn((_d: string, cb: (e?: Error) => void) => cb()) };

      const rpcSpy = vi.spyOn(channel as any, 'rpcCall').mockResolvedValue({});
      await channel.sendMessage('sig:+1234567890', 'Hello');

      expect(rpcSpy).toHaveBeenCalledWith('send', {
        message: 'Hello',
        recipient: ['+1234567890'],
      });
    });

    it('sends group message with groupId param', async () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      (channel as any).connected = true;
      (channel as any).socket = { write: vi.fn((_d: string, cb: (e?: Error) => void) => cb()) };

      const rpcSpy = vi.spyOn(channel as any, 'rpcCall').mockResolvedValue({});
      await channel.sendMessage('sig:g:ABC123==', 'Group hello');

      expect(rpcSpy).toHaveBeenCalledWith('send', {
        message: 'Group hello',
        groupId: 'ABC123==',
      });
    });

    it('queues message when not connected', async () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());

      await channel.sendMessage('sig:+1234567890', 'Hello');

      expect((channel as any).outgoingQueue).toHaveLength(1);
      expect((channel as any).outgoingQueue[0]).toEqual({ jid: 'sig:+1234567890', text: 'Hello' });
    });

    it('queues message on send failure', async () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      (channel as any).connected = true;

      vi.spyOn(channel as any, 'rpcCall').mockRejectedValue(new Error('TCP error'));

      await channel.sendMessage('sig:+1234567890', 'fail');

      expect((channel as any).outgoingQueue).toHaveLength(1);
      expect((channel as any).outgoingQueue[0]).toEqual({ jid: 'sig:+1234567890', text: 'fail' });
    });
  });

  // --- Outgoing queue ---

  describe('outgoing queue', () => {
    it('drops oldest message when queue exceeds cap', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      const queue = (channel as any).outgoingQueue as Array<{ jid: string; text: string }>;

      // Fill to cap
      for (let i = 0; i < 1000; i++) {
        queue.push({ jid: 'sig:+111', text: `msg-${i}` });
      }

      // Enqueue one more via sendMessage (not connected → enqueues)
      channel.sendMessage('sig:+1234567890', 'overflow');

      expect(queue).toHaveLength(1000);
      expect(queue[0].text).toBe('msg-1');
      expect(queue[queue.length - 1].text).toBe('overflow');
    });
  });

  // --- RPC cap ---

  describe('pending RPC cap', () => {
    it('rejects when pending requests exceed cap', async () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      (channel as any).connected = true;
      (channel as any).socket = {
        write: vi.fn((_d: string, cb: (e?: Error) => void) => cb()),
      };

      // Fill pending requests to cap
      const pending = (channel as any).pendingRequests;
      for (let i = 0; i < 100; i++) {
        pending.set(i, { resolve: vi.fn(), reject: vi.fn(), timer: setTimeout(() => {}, 99999) });
      }

      // Next RPC call should be rejected
      await expect(
        (channel as any).rpcCall('send', { message: 'test' }),
      ).rejects.toThrow('RPC cap exceeded');

      // Cleanup timers
      for (const [, p] of pending) clearTimeout(p.timer);
    });
  });

  // --- Disconnect cleanup ---

  describe('disconnect cleanup', () => {
    it('clears buffer, queue, and flushing flag', async () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      (channel as any).connected = true;
      (channel as any).buffer = 'some leftover data';
      (channel as any).outgoingQueue = [{ jid: 'sig:+111', text: 'queued' }];
      (channel as any).flushing = true;

      await channel.disconnect();

      expect((channel as any).buffer).toBe('');
      expect((channel as any).outgoingQueue).toHaveLength(0);
      expect((channel as any).flushing).toBe(false);
    });

    it('clears pending RPC timers and rejects them', async () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      (channel as any).connected = true;

      const rejectFn = vi.fn();
      const timer = setTimeout(() => {}, 99999);
      const clearSpy = vi.spyOn(global, 'clearTimeout');
      (channel as any).pendingRequests.set(1, { resolve: vi.fn(), reject: rejectFn, timer });

      await channel.disconnect();

      expect(clearSpy).toHaveBeenCalledWith(timer);
      expect(rejectFn).toHaveBeenCalledWith(expect.any(Error));
      expect((channel as any).pendingRequests.size).toBe(0);
    });

    it('destroys socket', async () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      (channel as any).connected = true;
      const mockSocket = { destroy: vi.fn() };
      (channel as any).socket = mockSocket;

      await channel.disconnect();

      expect(mockSocket.destroy).toHaveBeenCalled();
      expect((channel as any).socket).toBeNull();
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('isConnected() returns false before connect', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnect sets connected to false', async () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      (channel as any).connected = true;

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "signal"', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      expect(channel.name).toBe('signal');
    });

    it('parses host and port from daemon URL', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      expect((channel as any).host).toBe('localhost');
      expect((channel as any).port).toBe(7583);
    });

    it('strips tcp:// prefix from daemon URL', () => {
      const channel = new SignalChannel('+9999999999', 'tcp://localhost:8080', createTestOpts());
      expect((channel as any).host).toBe('localhost');
      expect((channel as any).port).toBe(8080);
    });

    it('uses custom assistantName from opts', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts({ assistantName: 'Jarvis' }));
      expect((channel as any).assistantName).toBe('Jarvis');
    });

    it('defaults assistantName to Andy', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      expect((channel as any).assistantName).toBe('Andy');
    });
  });
});
