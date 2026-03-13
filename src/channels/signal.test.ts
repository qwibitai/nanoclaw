import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks (must be before imports) ---

vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/nanoclaw-test-store',
  ASSISTANT_NAME: 'Andy',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

vi.mock('../transcription.js', () => ({
  transcribeAudioFile: vi.fn().mockResolvedValue('Hello from voice'),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    },
  };
});

// Build a fake SignalCli that extends EventEmitter
function createFakeSignalCli() {
  const instance = new EventEmitter() as EventEmitter & {
    connect: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    sendTyping: ReturnType<typeof vi.fn>;
    gracefulShutdown: ReturnType<typeof vi.fn>;
  };
  instance.connect = vi.fn().mockResolvedValue(undefined);
  instance.sendMessage = vi
    .fn()
    .mockResolvedValue({ timestamp: Date.now(), results: [] });
  instance.sendTyping = vi.fn().mockResolvedValue(undefined);
  instance.gracefulShutdown = vi.fn().mockResolvedValue(undefined);
  return instance;
}

let fakeSignalCli: ReturnType<typeof createFakeSignalCli>;

const { SignalCliSpy } = vi.hoisted(() => {
  const SignalCliSpy = vi.fn(function MockSignalCli(this: unknown) {
    return fakeSignalCli;
  });
  return { SignalCliSpy };
});

vi.mock('signal-sdk', () => {
  return {
    SignalCli: SignalCliSpy,
  };
});

import { SignalChannel } from './signal.js';
import { transcribeAudioFile } from '../transcription.js';
import type { ChannelOpts } from './registry.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:+447700900000': {
        name: 'Test Chat',
        folder: 'test-chat',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function emitMessage(params: unknown) {
  fakeSignalCli.emit('message', params);
}

async function flushAsync() {
  await new Promise((r) => setTimeout(r, 0));
}

// --- Tests ---

describe('SignalChannel', () => {
  beforeEach(() => {
    process.env.SIGNAL_BOT_PHONE = '+447700900000';
    process.env.SIGNAL_USER_PHONE = '+447700900001';
    fakeSignalCli = createFakeSignalCli();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.SIGNAL_BOT_PHONE;
    delete process.env.SIGNAL_USER_PHONE;
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "signal"', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.name).toBe('signal');
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns signal:-prefixed JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('signal:+447700900001')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });

    it('does not own plain phone numbers without prefix', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('+447700900001')).toBe(false);
    });

    it('does not own empty string', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('')).toBe(false);
    });
  });

  // --- Connection lifecycle ---

  describe('connect', () => {
    it('creates SignalCli with phone number, calls connect, and registers message handler', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);

      await channel.connect();

      expect(SignalCliSpy).toHaveBeenCalledWith('+447700900000');
      expect(fakeSignalCli.connect).toHaveBeenCalled();
      expect(channel.isConnected()).toBe(true);
    });

    it('returns true for isConnected after connect', async () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.isConnected()).toBe(false);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });
  });

  // --- Disconnect ---

  describe('disconnect', () => {
    it('calls gracefulShutdown and sets connected to false', async () => {
      const channel = new SignalChannel(createTestOpts());
      await channel.connect();

      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();

      expect(fakeSignalCli.gracefulShutdown).toHaveBeenCalled();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Message handling ---

  describe('message handling', () => {
    async function connectChannel(opts?: ChannelOpts) {
      const channel = new SignalChannel(opts ?? createTestOpts());
      await channel.connect();
      return channel;
    }

    it('processes a dataMessage and calls onMessage with bot JID as chatJid', async () => {
      // In primary device mode, DMs set chatPhone = this.phoneNumber (the bot's number).
      // The registered group JID is signal:+447700900000 (bot's number).
      // The sender field still reflects who sent the message (+447700900001).
      const opts = createTestOpts();
      await connectChannel(opts);

      const ts = Date.now();
      emitMessage({
        envelope: {
          source: '+447700900001',
          sourceNumber: '+447700900001',
          sourceName: 'Alice',
          timestamp: ts,
          dataMessage: {
            message: 'Hello Andy',
            attachments: [],
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+447700900000',
        expect.objectContaining({
          chat_jid: 'signal:+447700900000',
          sender: 'signal:+447700900001',
          sender_name: 'Alice',
          content: 'Hello Andy',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('calls onChatMetadata for all messages including unregistered chats', async () => {
      // Even for unregistered senders, onChatMetadata is called with the bot JID
      // (chatPhone = this.phoneNumber in primary device mode).
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      await connectChannel(opts);

      const ts = Date.now();
      emitMessage({
        envelope: {
          source: '+447700999999',
          sourceNumber: '+447700999999',
          sourceName: 'Unknown',
          timestamp: ts,
          dataMessage: {
            message: 'Hey',
            attachments: [],
          },
        },
      });
      await flushAsync();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:+447700900000',
        expect.any(String),
        'Unknown',
        'signal',
        false,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('does not call onMessage for unregistered chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      await connectChannel(opts);

      emitMessage({
        envelope: {
          source: '+447700999999',
          sourceNumber: '+447700999999',
          sourceName: 'Unknown',
          timestamp: Date.now(),
          dataMessage: {
            message: 'Hey',
            attachments: [],
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('detects syncMessage with assistant prefix as bot message (Note to Self echo)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'signal:+447700900000': {
            name: 'Note to Self',
            folder: 'signal_main',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      await connectChannel(opts);

      // Bot reply synced back — destination is own number (Note to Self).
      // chatPhone = destinationNumber = +447700900000 = this.phoneNumber → passes filter.
      emitMessage({
        envelope: {
          source: '+447700900000',
          sourceNumber: '+447700900000',
          sourceName: 'Me',
          timestamp: Date.now(),
          syncMessage: {
            sentMessage: {
              destination: '+447700900000',
              destinationNumber: '+447700900000',
              message: 'Andy: Hello from bot',
              attachments: [],
            },
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+447700900000',
        expect.objectContaining({
          is_from_me: false,
          is_bot_message: true,
          content: 'Andy: Hello from bot',
        }),
      );
    });

    it('treats syncMessage without assistant prefix as user message (Note to Self)', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'signal:+447700900000': {
            name: 'Test',
            folder: 'test',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      await connectChannel(opts);

      emitMessage({
        envelope: {
          source: '+447700900000',
          sourceNumber: '+447700900000',
          sourceName: 'Greg',
          timestamp: Date.now(),
          syncMessage: {
            sentMessage: {
              destination: '+447700900000',
              destinationNumber: '+447700900000',
              message: 'Hello from my phone',
              attachments: [],
            },
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+447700900000',
        expect.objectContaining({
          is_from_me: true,
          is_bot_message: false,
          content: 'Hello from my phone',
        }),
      );
    });

    it('ignores syncMessages for other conversations (not Note to Self)', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      // User sends a message to someone else — destination != phoneNumber, filtered out.
      emitMessage({
        envelope: {
          source: '+447700900000',
          sourceNumber: '+447700900000',
          sourceName: 'Me',
          timestamp: Date.now(),
          syncMessage: {
            sentMessage: {
              destinationNumber: '+447700900999',
              destination: '+447700900999',
              message: 'Hey friend!',
              attachments: [],
            },
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores syncMessages for group conversations', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      // User sends a message in a Signal group — should be ignored
      emitMessage({
        envelope: {
          source: '+447700900000',
          sourceNumber: '+447700900000',
          sourceName: 'Me',
          timestamp: Date.now(),
          syncMessage: {
            sentMessage: {
              destination: 'mK9qL+pQrStUv/w==',
              message: 'Hello group!',
              attachments: [],
            },
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores messages with no text and no audio attachments', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      emitMessage({
        envelope: {
          source: '+447700900001',
          sourceNumber: '+447700900001',
          sourceName: 'Alice',
          timestamp: Date.now(),
          dataMessage: {
            attachments: [],
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores receipt events (no dataMessage or syncMessage)', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      emitMessage({
        envelope: {
          source: '+447700900001',
          sourceNumber: '+447700900001',
          timestamp: Date.now(),
          receiptMessage: {
            type: 'read',
            timestamps: [Date.now()],
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores typing events (no dataMessage or syncMessage)', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      emitMessage({
        envelope: {
          source: '+447700900001',
          sourceNumber: '+447700900001',
          timestamp: Date.now(),
          typingMessage: {
            action: 'start',
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('falls back to sourceNumber for sender_name when sourceName is absent', async () => {
      // dataMessage → chatJid = signal:+447700900000 (bot JID, primary device mode)
      const opts = createTestOpts();
      await connectChannel(opts);

      emitMessage({
        envelope: {
          source: '+447700900001',
          sourceNumber: '+447700900001',
          timestamp: Date.now(),
          dataMessage: {
            message: 'No name here',
            attachments: [],
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+447700900000',
        expect.objectContaining({
          sender_name: '+447700900001',
        }),
      );
    });

    it('detects bot message by ASSISTANT_NAME prefix in dataMessage', async () => {
      // dataMessage → chatJid = signal:+447700900000 (bot JID, primary device mode)
      const opts = createTestOpts();
      await connectChannel(opts);

      emitMessage({
        envelope: {
          source: '+447700900001',
          sourceNumber: '+447700900001',
          sourceName: 'Alice',
          timestamp: Date.now(),
          dataMessage: {
            message: 'Andy: A prefixed message',
            attachments: [],
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+447700900000',
        expect.objectContaining({
          is_bot_message: true,
        }),
      );
    });
  });

  // --- Voice transcription ---

  describe('voice transcription', () => {
    async function connectChannel(opts?: ChannelOpts) {
      const channel = new SignalChannel(opts ?? createTestOpts());
      await channel.connect();
      return channel;
    }

    it('transcribes audio attachment by resolving id to signal-cli attachments dir', async () => {
      // dataMessage → chatJid = signal:+447700900000 (bot JID, primary device mode)
      const opts = createTestOpts();
      await connectChannel(opts);

      emitMessage({
        envelope: {
          source: '+447700900001',
          sourceNumber: '+447700900001',
          sourceName: 'Alice',
          timestamp: Date.now(),
          dataMessage: {
            attachments: [
              {
                id: 'abc123.m4a',
                filename: 'voice.m4a',
                contentType: 'audio/aac',
              },
            ],
          },
        },
      });
      await flushAsync();

      // fs.existsSync is mocked to true, so id-based path resolves
      expect(transcribeAudioFile).toHaveBeenCalledWith(
        expect.stringContaining('signal-cli/attachments/abc123.m4a'),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+447700900000',
        expect.objectContaining({
          content: '[Voice: Hello from voice]',
        }),
      );
    });

    it('falls back to localPath when id-based path does not exist', async () => {
      // Override existsSync to return false for attachment dir lookup
      const fsMod = await import('fs');
      const existsSpy = vi
        .spyOn(fsMod.default, 'existsSync')
        .mockReturnValue(false);

      const opts = createTestOpts();
      await connectChannel(opts);

      emitMessage({
        envelope: {
          source: '+447700900001',
          sourceNumber: '+447700900001',
          sourceName: 'Alice',
          timestamp: Date.now(),
          dataMessage: {
            attachments: [
              {
                id: 'att-1',
                filename: 'voice.ogg',
                contentType: 'audio/ogg; codecs=opus',
                localPath: '/tmp/signal-attachments/voice.ogg',
              },
            ],
          },
        },
      });
      await flushAsync();

      expect(transcribeAudioFile).toHaveBeenCalledWith(
        '/tmp/signal-attachments/voice.ogg',
      );

      existsSpy.mockRestore();
    });

    it('falls back gracefully when audio localPath is missing', async () => {
      const opts = createTestOpts();
      await connectChannel(opts);

      emitMessage({
        envelope: {
          source: '+447700900001',
          sourceNumber: '+447700900001',
          sourceName: 'Alice',
          timestamp: Date.now(),
          dataMessage: {
            attachments: [
              {
                filename: 'voice.ogg',
                contentType: 'audio/ogg',
                // no id and no localPath — cannot resolve file
              },
            ],
          },
        },
      });
      await flushAsync();

      expect(transcribeAudioFile).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+447700900000',
        expect.objectContaining({
          content: '[Voice Message - transcription unavailable]',
        }),
      );
    });

    it('falls back when transcribeAudioFile returns null', async () => {
      vi.mocked(transcribeAudioFile).mockResolvedValueOnce(null);

      const opts = createTestOpts();
      await connectChannel(opts);

      emitMessage({
        envelope: {
          source: '+447700900001',
          sourceNumber: '+447700900001',
          sourceName: 'Alice',
          timestamp: Date.now(),
          dataMessage: {
            attachments: [
              {
                id: 'att-3',
                filename: 'voice.ogg',
                contentType: 'audio/ogg',
                localPath: '/tmp/signal-attachments/voice.ogg',
              },
            ],
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+447700900000',
        expect.objectContaining({
          content: '[Voice Message - transcription unavailable]',
        }),
      );
    });

    it('falls back when transcribeAudioFile throws', async () => {
      vi.mocked(transcribeAudioFile).mockRejectedValueOnce(
        new Error('whisper fail'),
      );

      const opts = createTestOpts();
      await connectChannel(opts);

      emitMessage({
        envelope: {
          source: '+447700900001',
          sourceNumber: '+447700900001',
          sourceName: 'Alice',
          timestamp: Date.now(),
          dataMessage: {
            attachments: [
              {
                id: 'att-4',
                filename: 'voice.ogg',
                contentType: 'audio/ogg',
                localPath: '/tmp/signal-attachments/voice.ogg',
              },
            ],
          },
        },
      });
      await flushAsync();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+447700900000',
        expect.objectContaining({
          content: '[Voice Message - transcription failed]',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('redirects to ownerPhone when sending to the bot JID (signal:+447700900000)', async () => {
      // The registered group JID is signal:+447700900000 (bot's own number).
      // sendMessage() detects rawPhone === this.phoneNumber and routes to ownerPhone instead.
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      await channel.sendMessage('signal:+447700900000', 'Hello world');

      expect(fakeSignalCli.sendMessage).toHaveBeenCalledWith(
        '+447700900001',
        'Andy: Hello world',
      );
    });

    it('sends directly to phone when JID does not match bot number', async () => {
      // Sending to signal:+447700900001 — rawPhone (+447700900001) != phoneNumber (+447700900000),
      // so no owner-phone redirect; sends directly.
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      await channel.sendMessage('signal:+447700900001', 'Direct message');

      expect(fakeSignalCli.sendMessage).toHaveBeenCalledWith(
        '+447700900001',
        'Andy: Direct message',
      );
    });

    it('strips signal: prefix and prepends assistant name before sending', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      await channel.sendMessage('signal:+447700900001', 'Hello world');

      expect(fakeSignalCli.sendMessage).toHaveBeenCalledWith(
        '+447700900001',
        'Andy: Hello world',
      );
    });

    it('sends directly when connected', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      await channel.sendMessage('signal:+447700900001', 'Direct send');

      expect(fakeSignalCli.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      // Not connected yet

      await channel.sendMessage('signal:+447700900001', 'Queued message');

      expect(fakeSignalCli.sendMessage).not.toHaveBeenCalled();
    });

    it('flushes queued messages on connect, redirecting bot-JID sends to ownerPhone', async () => {
      // Messages queued for signal:+447700900000 (bot JID) are redirected to +447700900001
      // (ownerPhone) when flushed after connect.
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);

      // Queue messages while disconnected — using bot JID triggers owner-phone redirect
      await channel.sendMessage('signal:+447700900000', 'First');
      await channel.sendMessage('signal:+447700900000', 'Second');

      expect(fakeSignalCli.sendMessage).not.toHaveBeenCalled();

      // Connect — flush happens automatically
      await channel.connect();
      await flushAsync();

      expect(fakeSignalCli.sendMessage).toHaveBeenCalledTimes(2);
      expect(fakeSignalCli.sendMessage).toHaveBeenNthCalledWith(
        1,
        '+447700900001',
        'Andy: First',
      );
      expect(fakeSignalCli.sendMessage).toHaveBeenNthCalledWith(
        2,
        '+447700900001',
        'Andy: Second',
      );
    });

    it('handles jid without signal: prefix gracefully', async () => {
      // Raw phone number without prefix — jidToPhone returns it unchanged.
      // +447700900001 != phoneNumber (+447700900000), so sends directly.
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      await channel.sendMessage('+447700900001', 'No prefix');

      expect(fakeSignalCli.sendMessage).toHaveBeenCalledWith(
        '+447700900001',
        'Andy: No prefix',
      );
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('calls sendTyping with stop=false when typing starts', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      await channel.setTyping!('signal:+447700900001', true);

      expect(fakeSignalCli.sendTyping).toHaveBeenCalledWith(
        '+447700900001',
        false,
      );
    });

    it('calls sendTyping with stop=true when typing stops', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      await channel.setTyping!('signal:+447700900001', false);

      expect(fakeSignalCli.sendTyping).toHaveBeenCalledWith(
        '+447700900001',
        true,
      );
    });

    it('handles typing failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      fakeSignalCli.sendTyping.mockRejectedValueOnce(new Error('failed'));

      // Should not throw
      await expect(
        channel.setTyping!('signal:+447700900001', true),
      ).resolves.toBeUndefined();
    });
  });
});
