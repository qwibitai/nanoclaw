import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  MAIN_GROUP_FOLDER: 'main',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock readline to avoid real stdin/stdout
const mockRlInstance = Object.assign(new EventEmitter(), {
  prompt: vi.fn(),
  close: vi.fn(),
});

vi.mock('readline', () => ({
  default: {
    createInterface: vi.fn(() => mockRlInstance),
  },
}));

import { CliChannel } from './cli.js';
import { ChannelOpts } from '../types.js';

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    registerGroup: vi.fn(),
    ...overrides,
  };
}

describe('CliChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset EventEmitter listeners between tests
    mockRlInstance.removeAllListeners();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('channel properties', () => {
    it('has name "cli"', () => {
      const channel = new CliChannel(createTestOpts());
      expect(channel.name).toBe('cli');
    });
  });

  describe('ownsJid', () => {
    it('owns cli: prefixed JIDs', () => {
      const channel = new CliChannel(createTestOpts());
      expect(channel.ownsJid('cli:console')).toBe(true);
      expect(channel.ownsJid('cli:other')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new CliChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new CliChannel(createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });
  });

  describe('connect', () => {
    it('auto-registers as main group with requiresTrigger false', async () => {
      const opts = createTestOpts();
      const channel = new CliChannel(opts);

      await channel.connect();

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'cli:console',
        expect.objectContaining({
          name: 'CLI',
          folder: 'main',
          requiresTrigger: false,
        }),
      );
    });

    it('sets connected to true', async () => {
      const opts = createTestOpts();
      const channel = new CliChannel(opts);

      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('shows prompt after connecting', async () => {
      const opts = createTestOpts();
      const channel = new CliChannel(opts);

      await channel.connect();

      expect(mockRlInstance.prompt).toHaveBeenCalled();
    });
  });

  describe('message delivery', () => {
    it('delivers user input as messages via onMessage', async () => {
      const opts = createTestOpts();
      const channel = new CliChannel(opts);

      await channel.connect();

      // Simulate user typing a line
      mockRlInstance.emit('line', 'Hello Andy');

      expect(opts.onMessage).toHaveBeenCalledWith(
        'cli:console',
        expect.objectContaining({
          chat_jid: 'cli:console',
          sender: 'cli:user',
          sender_name: 'User',
          content: 'Hello Andy',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('emits chat metadata before message', async () => {
      const opts = createTestOpts();
      const channel = new CliChannel(opts);

      await channel.connect();

      mockRlInstance.emit('line', 'test');

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'cli:console',
        expect.any(String),
        'CLI',
        'cli',
        false,
      );
    });

    it('ignores empty lines', async () => {
      const opts = createTestOpts();
      const channel = new CliChannel(opts);

      await channel.connect();

      mockRlInstance.emit('line', '');
      mockRlInstance.emit('line', '   ');

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('prints to stdout with assistant name prefix', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const opts = createTestOpts();
      const channel = new CliChannel(opts);

      await channel.connect();
      await channel.sendMessage('cli:console', 'Hello user!');

      expect(consoleSpy).toHaveBeenCalledWith('Andy: Hello user!');
      consoleSpy.mockRestore();
    });
  });

  describe('disconnect', () => {
    it('sets connected to false and closes readline', async () => {
      const opts = createTestOpts();
      const channel = new CliChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(mockRlInstance.close).toHaveBeenCalled();
    });
  });
});
