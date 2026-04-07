import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelOpts } from './registry.js';
import { MATRIX_JID_PREFIX, MatrixChannel, toJid, toRoomId } from './matrix.js';

// ─── Mock matrix-js-sdk ──────────────────────────────────────────────────────

// Build a typed mock client object we can inspect in tests.
function makeMockClient() {
  return {
    initRustCrypto: vi.fn().mockResolvedValue(undefined),
    getCrypto: vi.fn().mockReturnValue({
      setGlobalErrorOnUnknownDevices: vi.fn(),
    }),
    on: vi.fn(),
    once: vi.fn(),
    startClient: vi.fn().mockResolvedValue(undefined),
    stopClient: vi.fn(),
    joinRoom: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ event_id: '$mock-event-id' }),
    sendTyping: vi.fn().mockResolvedValue(undefined),
    getRooms: vi.fn().mockReturnValue([]),
  };
}

type MockClient = ReturnType<typeof makeMockClient>;

// Module-level mock client shared via the module factory closure.
let _mockClient: MockClient = makeMockClient();

vi.mock('matrix-js-sdk', () => ({
  createClient: vi.fn(() => _mockClient),
  MemoryStore: vi.fn(),
  ClientEvent: { Sync: 'sync' },
  RoomEvent: { Timeline: 'Room.timeline', MyMembership: 'RoomMember.membership' },
  SyncState: { Prepared: 'PREPARED' },
  MsgType: { Text: 'm.text', Notice: 'm.notice' },
  EventType: { RoomMessage: 'm.room.message' },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  };
}

// ─── JID helpers ─────────────────────────────────────────────────────────────

describe('toJid / toRoomId', () => {
  it('toJid prefixes the room ID', () => {
    expect(toJid('!abc:matrix.org')).toBe('matrix:!abc:matrix.org');
  });

  it('toRoomId strips the prefix', () => {
    expect(toRoomId('matrix:!abc:matrix.org')).toBe('!abc:matrix.org');
  });

  it('round-trips correctly', () => {
    const roomId = '!xyz:example.com';
    expect(toRoomId(toJid(roomId))).toBe(roomId);
  });
});

// ─── Factory: returns null without credentials ────────────────────────────────

describe('registerChannel factory', () => {
  const VARS = ['MATRIX_HOMESERVER', 'MATRIX_ACCESS_TOKEN', 'MATRIX_USER_ID'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
    VARS.forEach((k) => delete process.env[k]);
  });

  afterEach(() => {
    VARS.forEach((k) => {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    });
  });

  it('returns null when all credentials are absent', async () => {
    const { getChannelFactory } = await import('./registry.js');
    const factory = getChannelFactory('matrix');
    expect(factory).toBeDefined();
    expect(factory!(makeOpts())).toBeNull();
  });

  it('returns null when only MATRIX_HOMESERVER is set', async () => {
    process.env['MATRIX_HOMESERVER'] = 'https://matrix.org';
    const { getChannelFactory } = await import('./registry.js');
    const factory = getChannelFactory('matrix');
    expect(factory!(makeOpts())).toBeNull();
  });
});

// ─── MatrixChannel ────────────────────────────────────────────────────────────

describe('MatrixChannel', () => {
  let channel: MatrixChannel;
  let opts: ChannelOpts;
  let mockClient: MockClient;

  beforeEach(() => {
    opts = makeOpts();
    mockClient = makeMockClient();
    _mockClient = mockClient;

    // Resolve connect() immediately by emitting 'PREPARED' on `once`.
    mockClient.once.mockImplementation(
      (_event: string, cb: (state: string) => void) => void cb('PREPARED'),
    );

    channel = new MatrixChannel(mockClient as any, '@bot:matrix.org', opts);
  });

  it('calls initRustCrypto on connect', async () => {
    await channel.connect();
    expect(mockClient.initRustCrypto).toHaveBeenCalledOnce();
  });

  it('starts the client on connect', async () => {
    await channel.connect();
    expect(mockClient.startClient).toHaveBeenCalledWith({ initialSyncLimit: 10 });
  });

  it('reports disconnected before connect()', () => {
    expect(channel.isConnected()).toBe(false);
  });

  it('reports connected after connect()', async () => {
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
  });

  it('reports disconnected after disconnect()', async () => {
    await channel.connect();
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
    expect(mockClient.stopClient).toHaveBeenCalledOnce();
  });

  it('ownsJid returns true for matrix: prefix', () => {
    expect(channel.ownsJid('matrix:!room:example.com')).toBe(true);
  });

  it('ownsJid returns false for other prefixes', () => {
    expect(channel.ownsJid('tg:123456')).toBe(false);
    expect(channel.ownsJid('')).toBe(false);
  });

  it('sendMessage forwards to client with correct room ID', async () => {
    await channel.sendMessage('matrix:!room:example.com', 'hello');
    expect(mockClient.sendMessage).toHaveBeenCalledWith('!room:example.com', {
      msgtype: 'm.text',
      body: 'hello',
    });
  });

  it('sendMessage splits text longer than 4000 chars into chunks', async () => {
    const longText = 'a'.repeat(9_000);
    await channel.sendMessage('matrix:!room:example.com', longText);
    // 9000 chars → chunks of 4000, 4000, 1000 = 3 calls
    expect(mockClient.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('setTyping delegates to client sendTyping', async () => {
    await channel.setTyping('matrix:!room:example.com', true);
    expect(mockClient.sendTyping).toHaveBeenCalledWith('!room:example.com', true, 5_000);
  });

  it('syncGroups calls onChatMetadata for each room', async () => {
    const fakeRooms = [
      { roomId: '!a:example.com', name: 'Alpha', getJoinedMemberCount: () => 5 },
      { roomId: '!b:example.com', name: 'Beta', getJoinedMemberCount: () => 2 },
    ];
    mockClient.getRooms.mockReturnValue(fakeRooms);

    await channel.syncGroups(false);

    expect(opts.onChatMetadata).toHaveBeenCalledTimes(2);
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'matrix:!a:example.com',
      expect.any(String),
      'Alpha',
      'matrix',
      true, // 5 members → group
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'matrix:!b:example.com',
      expect.any(String),
      'Beta',
      'matrix',
      false, // 2 members → DM
    );
  });

  it('MATRIX_JID_PREFIX constant is "matrix:"', () => {
    expect(MATRIX_JID_PREFIX).toBe('matrix:');
  });
});
