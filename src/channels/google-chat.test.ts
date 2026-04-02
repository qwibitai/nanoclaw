import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock variables (declared before vi.mock for hoisting) ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({
  registerChannel: vi.fn(),
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

// Mock backoff
vi.mock('../backoff.js', () => ({
  calculateBackoff: vi.fn((errors: number, base: number, _max: number) =>
    errors > 0 ? base * Math.pow(2, errors) : base,
  ),
}));

// Mock @google-cloud/firestore — return a constructor that yields a plain mock object
vi.mock('@google-cloud/firestore', () => ({
  Firestore: vi.fn(),
}));

// Mock google-auth-library
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(),
}));

// Mock googleapis
vi.mock('googleapis', () => ({
  google: {},
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => '{}'),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

import { GoogleChatChannel, GoogleChatChannelOpts } from './google-chat.js';
import { registerChannel } from './registry.js';
import { logger } from '../logger.js';
import { calculateBackoff } from '../backoff.js';

// Capture the factory registered at import time (before clearAllMocks wipes calls)
const registeredFactory = vi
  .mocked(registerChannel)
  .mock.calls.find((call) => call[0] === 'google-chat')?.[1];

// --- Firestore mock helpers ---
const mockUpdate = vi.fn().mockResolvedValue({});
const mockDoc = vi.fn().mockReturnValue({ update: mockUpdate });
const mockGet = vi.fn().mockResolvedValue({ empty: true, docs: [] });
const mockLimit = vi.fn().mockReturnValue({ get: mockGet });
const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
const mockCollection = vi.fn().mockReturnValue({
  where: mockWhere,
  doc: mockDoc,
});
const mockTerminate = vi.fn().mockResolvedValue(undefined);

function makeFirestoreMock() {
  return {
    collection: mockCollection,
    terminate: mockTerminate,
  };
}

// --- Auth mock helpers ---
const mockGetAccessToken = vi
  .fn()
  .mockResolvedValue({ token: 'test-access-token' });
const mockGetClient = vi.fn().mockResolvedValue({
  getAccessToken: mockGetAccessToken,
});

function makeAuthMock() {
  return {
    getClient: mockGetClient,
  };
}

// Mock fetch globally
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  text: () => Promise.resolve('{}'),
});
vi.stubGlobal('fetch', mockFetch);

function makeOpts(
  overrides?: Partial<GoogleChatChannelOpts>,
): GoogleChatChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({
      'main-jid': {
        name: 'Main Group',
        folder: 'main',
        trigger: '',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      },
    }),
    ...overrides,
  };
}

/**
 * Helper to create a connected GoogleChatChannel by setting private fields
 * to plain mock objects (avoids real Firestore/Auth construction).
 */
function createConnectedChannel(
  opts: GoogleChatChannelOpts,
): GoogleChatChannel {
  const channel = new GoogleChatChannel(opts, 5000);
  const any = channel as any;
  any.firestore = makeFirestoreMock();
  any.auth = makeAuthMock();
  any.chatBotAuth = any.auth;
  return channel;
}

describe('GoogleChatChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('{}'),
    });
    // Re-wire the chained mocks after clearAllMocks
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ get: mockGet });
    mockCollection.mockReturnValue({ where: mockWhere, doc: mockDoc });
    mockDoc.mockReturnValue({ update: mockUpdate });
    mockGet.mockResolvedValue({ empty: true, docs: [] });
    mockUpdate.mockResolvedValue({});
    mockGetClient.mockResolvedValue({ getAccessToken: mockGetAccessToken });
    mockGetAccessToken.mockResolvedValue({ token: 'test-access-token' });
    mockTerminate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Basic channel properties ---

  describe('ownsJid', () => {
    it('returns true for gchat: prefixed JIDs', () => {
      const ch = new GoogleChatChannel(makeOpts());
      expect(ch.ownsJid('gchat:spaces/abc')).toBe(true);
      expect(ch.ownsJid('gchat:spaces/123')).toBe(true);
    });

    it('returns false for non-gchat JIDs', () => {
      const ch = new GoogleChatChannel(makeOpts());
      expect(ch.ownsJid('gmail:thread-1')).toBe(false);
      expect(ch.ownsJid('12345@g.us')).toBe(false);
      expect(ch.ownsJid('tg:123')).toBe(false);
    });
  });

  describe('name', () => {
    it('is google-chat', () => {
      expect(new GoogleChatChannel(makeOpts()).name).toBe('google-chat');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(new GoogleChatChannel(makeOpts()).isConnected()).toBe(false);
    });

    it('returns true when firestore is set', () => {
      const ch = createConnectedChannel(makeOpts());
      expect(ch.isConnected()).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('terminates firestore and clears state', async () => {
      const ch = createConnectedChannel(makeOpts());
      await ch.disconnect();
      expect(ch.isConnected()).toBe(false);
      expect(mockTerminate).toHaveBeenCalled();
    });
  });

  // --- Poll processes messages ---

  describe('Poll processes messages', () => {
    it('processes messages with processed=false', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      const mockDocData = {
        spaceId: 'spaces/abc123',
        spaceName: 'Test Space',
        messageId: 'msg-1',
        messageName: 'spaces/abc123/messages/msg-1',
        text: 'Hello from chat',
        senderName: 'Alice',
        senderEmail: 'alice@company.com',
        senderType: 'HUMAN',
        createTime: '2024-01-01T12:00:00Z',
        agentName: 'nanoclaw',
        spaceType: 'SPACE',
        yacinePresent: true,
        processed: false,
      };

      mockGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'doc-1',
            data: () => mockDocData,
          },
        ],
      });

      await (ch as any).pollForMessages();

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'main-jid',
        expect.objectContaining({
          id: 'msg-1',
          chat_jid: 'main-jid',
          sender: 'alice@company.com',
          sender_name: 'Alice',
          is_from_me: false,
        }),
      );
    });

    it('resets consecutiveErrors on successful poll', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;
      any.consecutiveErrors = 3;

      mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

      await any.pollForMessages();

      expect(any.consecutiveErrors).toBe(0);
    });
  });

  // --- Skip yacinePresent=false ---

  describe('Skip yacinePresent=false', () => {
    it('marks processed but does not deliver when yacine not present', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      mockGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'doc-skip',
            data: () => ({
              spaceId: 'spaces/skip',
              spaceName: 'Skip Space',
              messageId: 'msg-skip',
              messageName: 'spaces/skip/messages/msg-skip',
              text: 'Should be skipped',
              senderName: 'Bob',
              senderEmail: 'bob@company.com',
              senderType: 'HUMAN',
              createTime: '2024-01-01T12:00:00Z',
              agentName: 'nanoclaw',
              yacinePresent: false,
              processed: false,
            }),
          },
        ],
      });

      await (ch as any).pollForMessages();

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ processed: true }),
      );
    });
  });

  // --- Message delivery formatting ---

  describe('Message delivery', () => {
    it('formats content with [Google Chat from...] prefix and [Reply to: gchat:...] tag', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      mockGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'doc-fmt',
            data: () => ({
              spaceId: 'spaces/fmt123',
              spaceName: 'Format Space',
              messageId: 'msg-fmt',
              messageName: 'spaces/fmt123/messages/msg-fmt',
              text: 'Test message content',
              senderName: 'Charlie',
              senderEmail: 'charlie@company.com',
              senderType: 'HUMAN',
              createTime: '2024-01-01T12:00:00Z',
              agentName: 'nanoclaw',
              spaceType: 'SPACE',
              yacinePresent: true,
              processed: false,
            }),
          },
        ],
      });

      await (ch as any).pollForMessages();

      const call = (opts.onMessage as ReturnType<typeof vi.fn>).mock.calls[0];
      const content = call[1].content;
      expect(content).toContain(
        '[Google Chat from Charlie <charlie@company.com> in Format Space]',
      );
      expect(content).toContain('[Reply to: gchat:spaces/fmt123]');
      expect(content).toContain('Test message content');
    });
  });

  // --- Mark processed ---

  describe('Mark processed', () => {
    it('updates document with processed=true and processedAt', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      await (ch as any).markProcessed('doc-mark');

      expect(mockCollection).toHaveBeenCalledWith(
        expect.stringContaining('chat-queue/'),
      );
      expect(mockDoc).toHaveBeenCalledWith('doc-mark');
      expect(mockUpdate).toHaveBeenCalledWith({
        processed: true,
        processedAt: expect.any(String),
      });
    });

    it('handles update failure gracefully', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      mockUpdate.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(
        (ch as any).markProcessed('doc-fail'),
      ).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ docId: 'doc-fail' }),
        expect.stringContaining('Failed to mark'),
      );
    });
  });

  // --- spaceIdToName cap ---

  describe('spaceIdToName cap', () => {
    it('prunes map when exceeding 500 entries', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      // Populate spaceIdToName beyond 500
      for (let i = 0; i < 510; i++) {
        any.spaceIdToName.set(`spaces/s${i}`, `spaces/s${i}`);
      }

      mockGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'doc-cap',
            data: () => ({
              spaceId: 'spaces/new',
              spaceName: 'New Space',
              messageId: 'msg-cap',
              messageName: 'spaces/new/messages/msg-cap',
              text: 'Cap test',
              senderName: 'Dana',
              senderEmail: 'dana@company.com',
              senderType: 'HUMAN',
              createTime: '2024-01-01T12:00:00Z',
              agentName: 'nanoclaw',
              spaceType: 'SPACE',
              yacinePresent: true,
              processed: false,
            }),
          },
        ],
      });

      await any.pollForMessages();

      // After adding 'spaces/new' (511 > 500 -> prune to last 250)
      expect(any.spaceIdToName.size).toBeLessThanOrEqual(251);
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('calls correct Chat API URL with bearer token', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      await ch.sendMessage('gchat:spaces/test123', 'Hello from bot');

      expect(mockGetClient).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        'https://chat.googleapis.com/v1/spaces/test123/messages',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-access-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: 'Hello from bot' }),
        },
      );
    });

    it('uses lastDeliveredSpaceName when jid is main', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;
      any.lastDeliveredSpaceName = 'spaces/last-delivered';

      await ch.sendMessage('gchat:main', 'Hello main');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://chat.googleapis.com/v1/spaces/last-delivered/messages',
        expect.any(Object),
      );
    });

    it('logs warning for invalid space ID (non-spaces/ prefix)', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      await ch.sendMessage('gchat:invalid-id', 'Hello');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'gchat:invalid-id' }),
        expect.stringContaining('invalid space ID'),
      );
    });

    it('returns early when auth is not initialized', async () => {
      const ch = new GoogleChatChannel(makeOpts());
      await ch.sendMessage('gchat:spaces/test', 'Hello');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'Google Chat auth not initialized',
      );
    });

    it('handles API error response', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Forbidden'),
      });

      await ch.sendMessage('gchat:spaces/forbidden', 'Hello');

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ status: 403 }),
        expect.stringContaining('Google Chat API error'),
      );
    });

    it('handles fetch exception gracefully', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      mockFetch.mockRejectedValueOnce(new Error('Network failure'));

      await ch.sendMessage('gchat:spaces/err', 'Hello');

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'gchat:spaces/err' }),
        expect.stringContaining('Failed to send'),
      );
    });
  });

  // --- Poll backoff ---

  describe('Poll backoff', () => {
    it('uses calculateBackoff on errors', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      mockGet.mockRejectedValueOnce(new Error('Firestore unavailable'));

      await (ch as any).pollForMessages();

      expect((ch as any).consecutiveErrors).toBe(1);
      expect(calculateBackoff).toHaveBeenCalledWith(1, 5000, 5 * 60 * 1000);
    });

    it('increments consecutiveErrors on repeated failures', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      mockGet.mockRejectedValueOnce(new Error('Error 1'));
      await (ch as any).pollForMessages();
      expect((ch as any).consecutiveErrors).toBe(1);

      mockGet.mockRejectedValueOnce(new Error('Error 2'));
      await (ch as any).pollForMessages();
      expect((ch as any).consecutiveErrors).toBe(2);
    });
  });

  // --- Channel registration ---

  describe('Channel registration', () => {
    it('registerChannel was called with google-chat at import time', () => {
      // registeredFactory was captured before clearAllMocks
      expect(registeredFactory).toBeDefined();
    });

    it('factory returns null when GOOGLE_CHAT_ENABLED is not true', () => {
      expect(registeredFactory).toBeDefined();

      const origEnv = process.env.GOOGLE_CHAT_ENABLED;
      delete process.env.GOOGLE_CHAT_ENABLED;

      const result = registeredFactory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn() as any,
      });
      expect(result).toBeNull();

      if (origEnv !== undefined) process.env.GOOGLE_CHAT_ENABLED = origEnv;
    });

    it('factory returns null when service account file does not exist', async () => {
      expect(registeredFactory).toBeDefined();

      const origEnv = process.env.GOOGLE_CHAT_ENABLED;
      process.env.GOOGLE_CHAT_ENABLED = 'true';

      const fsMod = await import('fs');
      vi.mocked(fsMod.default.existsSync).mockReturnValueOnce(false);

      const result = registeredFactory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn() as any,
      });
      expect(result).toBeNull();

      if (origEnv !== undefined) {
        process.env.GOOGLE_CHAT_ENABLED = origEnv;
      } else {
        delete process.env.GOOGLE_CHAT_ENABLED;
      }
    });

    it('factory returns GoogleChatChannel when enabled and SA exists', async () => {
      expect(registeredFactory).toBeDefined();

      const origEnv = process.env.GOOGLE_CHAT_ENABLED;
      process.env.GOOGLE_CHAT_ENABLED = 'true';

      const fsMod = await import('fs');
      vi.mocked(fsMod.default.existsSync).mockReturnValue(true);

      const result = registeredFactory!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: vi.fn() as any,
      });
      expect(result).toBeInstanceOf(GoogleChatChannel);

      if (origEnv !== undefined) {
        process.env.GOOGLE_CHAT_ENABLED = origEnv;
      } else {
        delete process.env.GOOGLE_CHAT_ENABLED;
      }
    });
  });

  // --- No main group ---

  describe('No main group', () => {
    it('skips delivery when no main group is registered', async () => {
      const opts = makeOpts({
        registeredGroups: () => ({
          'other-jid': {
            name: 'Not Main',
            folder: 'not-main',
            trigger: '@bot',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        }),
      });
      const ch = createConnectedChannel(opts);

      mockGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'doc-nomain',
            data: () => ({
              spaceId: 'spaces/nomain',
              spaceName: 'No Main Space',
              messageId: 'msg-nomain',
              messageName: 'spaces/nomain/messages/msg-nomain',
              text: 'Where does this go?',
              senderName: 'Eve',
              senderEmail: 'eve@company.com',
              senderType: 'HUMAN',
              createTime: '2024-01-01T12:00:00Z',
              agentName: 'nanoclaw',
              spaceType: 'SPACE',
              yacinePresent: true,
              processed: false,
            }),
          },
        ],
      });

      await (ch as any).pollForMessages();

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  // --- Metadata for DM vs group ---

  describe('Metadata for DM vs group', () => {
    it('passes isGroup=false for DIRECT_MESSAGE spaceType', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      mockGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'doc-dm',
            data: () => ({
              spaceId: 'spaces/dm123',
              spaceName: 'DM Space',
              messageId: 'msg-dm',
              messageName: 'spaces/dm123/messages/msg-dm',
              text: 'DM message',
              senderName: 'Frank',
              senderEmail: 'frank@company.com',
              senderType: 'HUMAN',
              createTime: '2024-01-01T12:00:00Z',
              agentName: 'nanoclaw',
              spaceType: 'DIRECT_MESSAGE',
              yacinePresent: true,
              processed: false,
            }),
          },
        ],
      });

      await (ch as any).pollForMessages();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'gchat:spaces/dm123',
        expect.any(String),
        'DM Space',
        'google-chat',
        false,
      );
    });

    it('passes isGroup=true for SPACE spaceType', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      mockGet.mockResolvedValueOnce({
        empty: false,
        docs: [
          {
            id: 'doc-space',
            data: () => ({
              spaceId: 'spaces/space123',
              spaceName: 'Team Space',
              messageId: 'msg-space',
              messageName: 'spaces/space123/messages/msg-space',
              text: 'Space message',
              senderName: 'Grace',
              senderEmail: 'grace@company.com',
              senderType: 'HUMAN',
              createTime: '2024-01-01T12:00:00Z',
              agentName: 'nanoclaw',
              spaceType: 'SPACE',
              yacinePresent: true,
              processed: false,
            }),
          },
        ],
      });

      await (ch as any).pollForMessages();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'gchat:spaces/space123',
        expect.any(String),
        'Team Space',
        'google-chat',
        true,
      );
    });
  });
});
