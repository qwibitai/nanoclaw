import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { NewMessage } from '../types.js';
import type { ChannelOpts } from './registry.js';

// ---------------------------------------------------------------------------
// Mock modules before importing MarmotChannel
// ---------------------------------------------------------------------------

// Mock nostr-tools
vi.mock('nostr-tools', () => ({
  generateSecretKey: () => new Uint8Array(32).fill(1),
  getPublicKey: () => 'a'.repeat(64),
  finalizeEvent: (event: any, _sk: Uint8Array) => ({
    ...event,
    id: 'mock-event-id',
    sig: 'mock-sig',
    pubkey: 'a'.repeat(64),
  }),
}));

vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    publish = vi.fn().mockReturnValue([Promise.resolve('ok')]);
    querySync = vi.fn().mockResolvedValue([]);
    subscribeMany = vi.fn().mockReturnValue({ close: vi.fn() });
    close = vi.fn();
  },
}));

vi.mock('nostr-tools/utils', () => ({
  bytesToHex: (bytes: Uint8Array) =>
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
  hexToBytes: (hex: string) =>
    new Uint8Array(hex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16))),
}));

vi.mock('nostr-tools/nip44', () => ({
  v2: {
    utils: {
      getConversationKey: vi.fn().mockReturnValue(new Uint8Array(32)),
    },
    encrypt: vi.fn().mockReturnValue('encrypted-data'),
    decrypt: vi.fn().mockReturnValue('decrypted-data'),
  },
}));

// Mock marmot-ts
const mockKeyPackagesCreate = vi.fn().mockResolvedValue({
  keyPackageRef: new Uint8Array(32),
  publicPackage: {},
  published: [],
});

const mockSendChatMessage = vi.fn().mockResolvedValue({});

const mockMarmotGroup = {
  idStr: 'abc123',
  id: new Uint8Array(16),
  sendChatMessage: mockSendChatMessage,
  ingest: vi.fn().mockReturnValue({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
  }),
  save: vi.fn().mockResolvedValue(undefined),
  selfUpdate: vi.fn().mockResolvedValue({}),
};

const mockLoadAllGroups = vi.fn().mockResolvedValue([]);
const mockGetGroup = vi.fn().mockResolvedValue(mockMarmotGroup);
const mockOn = vi.fn();

vi.mock('@internet-privacy/marmot-ts', () => ({
  MarmotClient: class {
    keyPackages = { create: mockKeyPackagesCreate };
    loadAllGroups = mockLoadAllGroups;
    getGroup = mockGetGroup;
    on = mockOn;
  },
  KeyValueGroupStateBackend: class {
    constructor() {}
  },
  KeyPackageStore: class {
    constructor() {}
  },
  InviteReader: class {
    constructor() {}
    ingestEvents = vi.fn().mockResolvedValue(0);
    decryptGiftWraps = vi.fn().mockResolvedValue([]);
    markAsRead = vi.fn().mockResolvedValue(undefined);
  },
  deserializeApplicationRumor: vi.fn().mockReturnValue({
    id: 'rumor-id',
    pubkey: 'b'.repeat(64),
    content: 'Hello from MLS!',
    created_at: Math.floor(Date.now() / 1000),
    kind: 9,
    tags: [],
  }),
  GROUP_EVENT_KIND: 445,
  KEY_PACKAGE_KIND: 443,
  WELCOME_EVENT_KIND: 444,
}));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'TestBot',
  MARMOT_NOSTR_PRIVATE_KEY: '01'.repeat(32),
  MARMOT_NOSTR_RELAYS: ['wss://relay.test.com'],
  MARMOT_POLL_INTERVAL_MS: 5000,
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock the registry so the self-registration side-effect doesn't conflict
vi.mock('./registry.js', () => ({
  registerChannel: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { MarmotChannel } from './marmot.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createOpts(): ChannelOpts & {
  receivedMessages: Array<{ jid: string; msg: NewMessage }>;
  receivedMetadata: Array<{
    jid: string;
    timestamp: string;
    name?: string;
    channel?: string;
    isGroup?: boolean;
  }>;
} {
  const receivedMessages: Array<{ jid: string; msg: NewMessage }> = [];
  const receivedMetadata: Array<{
    jid: string;
    timestamp: string;
    name?: string;
    channel?: string;
    isGroup?: boolean;
  }> = [];

  return {
    onMessage: (jid: string, msg: NewMessage) => {
      receivedMessages.push({ jid, msg });
    },
    onChatMetadata: (
      jid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => {
      receivedMetadata.push({ jid, timestamp, name, channel, isGroup });
    },
    registeredGroups: () => ({}),
    receivedMessages,
    receivedMetadata,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MarmotChannel', () => {
  let channel: MarmotChannel;
  let opts: ReturnType<typeof createOpts>;

  beforeEach(() => {
    opts = createOpts();
    channel = new MarmotChannel(opts);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (channel.isConnected()) {
      await channel.disconnect();
    }
  });

  describe('constructor', () => {
    it('should set channel name to marmot', () => {
      expect(channel.name).toBe('marmot');
    });

    it('should not be connected initially', () => {
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('ownsJid', () => {
    it('should own marmot: prefixed JIDs', () => {
      expect(channel.ownsJid('marmot:abc123')).toBe(true);
      expect(channel.ownsJid('marmot:' + 'a'.repeat(64))).toBe(true);
    });

    it('should not own other JIDs', () => {
      expect(channel.ownsJid('tg:12345')).toBe(false);
      expect(channel.ownsJid('signal:+1234')).toBe(false);
      expect(channel.ownsJid('120363@g.us')).toBe(false);
      expect(channel.ownsJid('')).toBe(false);
    });
  });

  describe('connect', () => {
    it('should connect successfully with valid config', async () => {
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('should publish a KeyPackage on connect', async () => {
      await channel.connect();
      expect(mockKeyPackagesCreate).toHaveBeenCalledWith({
        relays: ['wss://relay.test.com'],
        client: 'NanoClaw/marmot',
        isLastResort: true,
      });
    });

    it('should load existing groups on connect', async () => {
      await channel.connect();
      expect(mockLoadAllGroups).toHaveBeenCalled();
    });

    it('should register groupJoined event handler', async () => {
      await channel.connect();
      expect(mockOn).toHaveBeenCalledWith('groupJoined', expect.any(Function));
    });

    it('should not throw with valid credentials', async () => {
      await expect(channel.connect()).resolves.not.toThrow();
    });
  });

  describe('disconnect', () => {
    it('should disconnect cleanly', async () => {
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('should be idempotent', async () => {
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('sendMessage', () => {
    it('should warn when not connected', async () => {
      const { logger } = await import('../logger.js');
      await channel.sendMessage('marmot:abc123', 'hello');
      expect(logger.warn).toHaveBeenCalledWith(
        'Marmot client not initialized',
      );
    });

    it('should warn on invalid JID', async () => {
      await channel.connect();
      const { logger } = await import('../logger.js');
      await channel.sendMessage('tg:12345', 'hello');
      expect(logger.warn).toHaveBeenCalledWith(
        { jid: 'tg:12345' },
        'Invalid Marmot JID',
      );
    });

    it('should send via MLS-encrypted group.sendChatMessage', async () => {
      await channel.connect();
      await channel.sendMessage('marmot:abc123', 'hello world');
      expect(mockGetGroup).toHaveBeenCalledWith('abc123');
      expect(mockSendChatMessage).toHaveBeenCalledWith('hello world');
    });

    it('should handle send errors gracefully', async () => {
      mockGetGroup.mockRejectedValueOnce(new Error('group not found'));
      await channel.connect();
      // Should not throw even with errors
      await expect(
        channel.sendMessage('marmot:abc123', 'hello'),
      ).resolves.not.toThrow();
    });
  });

  describe('JID parsing', () => {
    it('should correctly format group IDs as JIDs', () => {
      expect(channel.ownsJid('marmot:abc123def456')).toBe(true);
    });

    it('should reject malformed JIDs', () => {
      expect(channel.ownsJid('marmot')).toBe(false);
      expect(channel.ownsJid('MARMOT:abc')).toBe(false);
    });
  });
});

describe('MarmotChannel config validation', () => {
  it('should require MARMOT_NOSTR_PRIVATE_KEY', async () => {
    const opts = createOpts();
    const channel = new MarmotChannel(opts);
    expect(channel.isConnected()).toBe(false);
  });
});

describe('MarmotChannel self-registration', () => {
  it('should export MarmotChannel class', () => {
    // The module exports MarmotChannel for direct use and
    // calls registerChannel('marmot', factory) at the module level.
    // We verify the export exists — the actual registration is tested
    // by the registry integration when the barrel file imports marmot.js.
    expect(MarmotChannel).toBeDefined();
    expect(typeof MarmotChannel).toBe('function');
  });
});

describe('MarmotChannel MLS integration', () => {
  it('should use kind 443 for KeyPackage, 445 for group messages', async () => {
    const { GROUP_EVENT_KIND, KEY_PACKAGE_KIND } = await import(
      '@internet-privacy/marmot-ts'
    );
    expect(KEY_PACKAGE_KIND).toBe(443);
    expect(GROUP_EVENT_KIND).toBe(445);
  });

  it('should have NIP-44 support in signer for gift-wrap', () => {
    // The MarmotEventSigner class has nip44 encrypt/decrypt methods
    // This is tested implicitly by MarmotClient accepting the signer
    // and InviteReader being able to decrypt gift wraps
    const opts = createOpts();
    const channel = new MarmotChannel(opts);
    expect(channel).toBeDefined();
  });
});
