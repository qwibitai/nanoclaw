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

import { SignalChannel, SignalChannelOpts } from './signal.js';

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
      const channel = new SignalChannel('+9999999999', 'localhost:7583',createTestOpts());
      expect(channel.ownsJid('sig:+1234567890')).toBe(true);
    });

    it('owns sig:g: JIDs (group)', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583',createTestOpts());
      expect(channel.ownsJid('sig:g:ABC123==')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583',createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583',createTestOpts());
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own Discord JIDs', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583',createTestOpts());
      expect(channel.ownsJid('dc:1234567890')).toBe(false);
    });
  });

  // --- handleEnvelope (message handling) ---

  describe('handleEnvelope', () => {
    it('delivers 1:1 message for registered chat', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

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
        }),
      );
    });

    it('delivers group message for registered group', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

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
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

      channel.handleEnvelope(createEnvelope({
        source: '+9876543210',
        sourceName: 'Unknown',
        message: 'Hi',
      }));

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores envelopes without dataMessage', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

      channel.handleEnvelope({ envelope: { source: '+1234567890', timestamp: 123 } });

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('marks own messages with is_from_me', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

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
        expect.objectContaining({ is_from_me: true }),
      );
    });

    it('falls back to sender phone when sourceName missing', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

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
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

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

  // --- Attachments ---

  describe('attachments', () => {
    it('stores image attachment with placeholder', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

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
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

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
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

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
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

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
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

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
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

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
      const channel = new SignalChannel('+9999999999', 'localhost:7583',opts);

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

    it('does nothing when not connected', async () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());

      const rpcSpy = vi.spyOn(channel as any, 'rpcCall');
      await channel.sendMessage('sig:+1234567890', 'Hello');

      expect(rpcSpy).not.toHaveBeenCalled();
    });

    it('handles send failure gracefully', async () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583', createTestOpts());
      (channel as any).connected = true;

      vi.spyOn(channel as any, 'rpcCall').mockRejectedValue(new Error('TCP error'));

      // Should not throw
      await expect(channel.sendMessage('sig:+1234567890', 'fail')).resolves.toBeUndefined();
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('isConnected() returns false before connect', () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583',createTestOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnect sets connected to false', async () => {
      const channel = new SignalChannel('+9999999999', 'localhost:7583',createTestOpts());
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
  });
});
