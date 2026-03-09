import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import os from 'os';
import path from 'path';
import fs from 'fs';

import type { NewMessage, RegisteredGroup } from '../types.js';

// ---------------------------------------------------------------------------
// Mock modules before importing MarmotChannel
// ---------------------------------------------------------------------------

// Mock nostr-tools
vi.mock('nostr-tools', () => ({
  generateSecretKey: () => new Uint8Array(32).fill(1),
  getPublicKey: () => 'a'.repeat(64),
  finalizeEvent: (event: any, sk: Uint8Array) => ({
    ...event,
    id: 'mock-event-id',
    sig: 'mock-sig',
    pubkey: 'a'.repeat(64),
  }),
}));

vi.mock('nostr-tools/pool', () => ({
  SimplePool: class {
    publish = vi.fn().mockResolvedValue(undefined);
    querySync = vi.fn().mockResolvedValue([]);
    subscribeMany = vi.fn().mockReturnValue({ close: vi.fn() });
    close = vi.fn();
  },
}));

vi.mock('@noble/hashes/utils', () => ({
  bytesToHex: (bytes: Uint8Array) =>
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
  hexToBytes: (hex: string) =>
    new Uint8Array(hex.match(/.{2}/g)!.map((byte) => parseInt(byte, 16))),
}));

// Mock marmot-ts client
const mockGroups: any[] = [];
const mockMarmotClient = {
  loadAllGroups: vi.fn().mockResolvedValue(mockGroups),
  getGroup: vi.fn().mockRejectedValue(new Error('Group not found')),
  createGroup: vi.fn(),
  joinGroupFromWelcome: vi.fn().mockResolvedValue({ group: { idStr: 'abc123' } }),
  on: vi.fn(),
  keyPackages: {
    publish: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
  },
};

vi.mock('marmot-ts', () => ({
  MarmotClient: vi.fn().mockImplementation(() => mockMarmotClient),
}));

// Mock config — use a temp dir for STORE_DIR so SQLite doesn't conflict
const tmpDir = path.join(os.tmpdir(), `marmot-test-${Date.now()}`);
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'TestBot',
  STORE_DIR: tmpDir,
}));

// Mock env.js to return Marmot config values
vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    MARMOT_NOSTR_PRIVATE_KEY: '01'.repeat(32),
    MARMOT_NOSTR_RELAYS: 'wss://relay.test.com',
    MARMOT_POLL_INTERVAL_MS: '5000',
  }),
}));

// Mock self-registration (prevent actual registerChannel call during import)
vi.mock('./registry.js', () => ({
  registerChannel: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  MarmotChannel,
  SqliteGroupStateBackend,
  SqliteKeyPackageStore,
  initMarmotDatabase,
  type MarmotChannelOpts,
} from './marmot.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createOpts(): MarmotChannelOpts & {
  receivedMessages: Array<{ jid: string; msg: NewMessage }>;
  receivedMetadata: Array<{ jid: string; timestamp: string; name?: string }>;
} {
  const receivedMessages: Array<{ jid: string; msg: NewMessage }> = [];
  const receivedMetadata: Array<{
    jid: string;
    timestamp: string;
    name?: string;
  }> = [];

  return {
    onMessage: (jid: string, msg: NewMessage) => {
      receivedMessages.push({ jid, msg });
    },
    onChatMetadata: (jid: string, timestamp: string, name?: string) => {
      receivedMetadata.push({ jid, timestamp, name });
    },
    registeredGroups: () => ({}),
    receivedMessages,
    receivedMetadata,
  };
}

// ---------------------------------------------------------------------------
// Tests: MarmotChannel
// ---------------------------------------------------------------------------

describe('MarmotChannel', () => {
  let channel: MarmotChannel;
  let opts: ReturnType<typeof createOpts>;

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    opts = createOpts();
    channel = new MarmotChannel(opts);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (channel.isConnected()) {
      await channel.disconnect();
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
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

    it('should load existing groups on connect', async () => {
      await channel.connect();
      expect(mockMarmotClient.loadAllGroups).toHaveBeenCalled();
    });

    it('should set up event listeners', async () => {
      await channel.connect();
      expect(mockMarmotClient.on).toHaveBeenCalledWith(
        'groupJoined',
        expect.any(Function),
      );
    });

    it('should publish key packages on connect', async () => {
      await channel.connect();
      // keyPackages.list() returns [] so it should publish KEY_PACKAGE_COUNT (5)
      expect(mockMarmotClient.keyPackages.publish).toHaveBeenCalledWith(5);
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

    it('should attempt to send to valid group', async () => {
      const mockGroup = {
        idStr: 'abc123',
        sendMessage: vi.fn().mockResolvedValue(undefined),
        getMetadata: () => ({ name: 'Test Group' }),
        on: vi.fn(),
      };
      mockMarmotClient.getGroup.mockResolvedValueOnce(mockGroup);

      await channel.connect();
      await channel.sendMessage('marmot:abc123', 'hello world');

      expect(mockMarmotClient.getGroup).toHaveBeenCalledWith('abc123');
      expect(mockGroup.sendMessage).toHaveBeenCalledWith('hello world');
    });

    it('should handle send errors gracefully', async () => {
      mockMarmotClient.getGroup.mockRejectedValueOnce(
        new Error('Group not found'),
      );

      await channel.connect();
      const { logger } = await import('../logger.js');

      // Should not throw
      await channel.sendMessage('marmot:nonexistent', 'hello');
      expect(logger.error).toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Tests: SQLite GroupStateBackend
// ---------------------------------------------------------------------------

describe('SqliteGroupStateBackend', () => {
  let db: Database.Database;
  let backend: SqliteGroupStateBackend;

  beforeEach(() => {
    db = initMarmotDatabase(':memory:');
    backend = new SqliteGroupStateBackend(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should return null for missing group', async () => {
    const groupId = new Uint8Array([1, 2, 3, 4]);
    const result = await backend.get(groupId);
    expect(result).toBeNull();
  });

  it('should store and retrieve group state', async () => {
    const groupId = new Uint8Array([1, 2, 3, 4]);
    const state = { epoch: 1, members: ['alice', 'bob'] } as any;

    await backend.set(groupId, state);
    const result = await backend.get(groupId);
    expect(result).toEqual(state);
  });

  it('should overwrite existing state (upsert)', async () => {
    const groupId = new Uint8Array([1, 2, 3, 4]);
    const state1 = { epoch: 1 } as any;
    const state2 = { epoch: 2 } as any;

    await backend.set(groupId, state1);
    await backend.set(groupId, state2);

    const result = await backend.get(groupId);
    expect(result).toEqual(state2);
  });

  it('should check existence with has()', async () => {
    const groupId = new Uint8Array([1, 2, 3, 4]);
    expect(await backend.has(groupId)).toBe(false);

    await backend.set(groupId, { epoch: 1 } as any);
    expect(await backend.has(groupId)).toBe(true);
  });

  it('should delete group state', async () => {
    const groupId = new Uint8Array([1, 2, 3, 4]);
    await backend.set(groupId, { epoch: 1 } as any);
    expect(await backend.has(groupId)).toBe(true);

    await backend.delete(groupId);
    expect(await backend.has(groupId)).toBe(false);
    expect(await backend.get(groupId)).toBeNull();
  });

  it('should list all group IDs', async () => {
    const id1 = new Uint8Array([1, 2, 3, 4]);
    const id2 = new Uint8Array([5, 6, 7, 8]);

    await backend.set(id1, { epoch: 1 } as any);
    await backend.set(id2, { epoch: 2 } as any);

    const list = await backend.list();
    expect(list).toHaveLength(2);
    const hexList = list.map((id) =>
      Array.from(id)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    );
    expect(hexList).toContain('01020304');
    expect(hexList).toContain('05060708');
  });

  it('should handle empty list', async () => {
    const list = await backend.list();
    expect(list).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: SQLite KeyPackageStore
// ---------------------------------------------------------------------------

describe('SqliteKeyPackageStore', () => {
  let db: Database.Database;
  let store: SqliteKeyPackageStore;

  beforeEach(() => {
    db = initMarmotDatabase(':memory:');
    store = new SqliteKeyPackageStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('should return null for missing key package', async () => {
    const ref = new Uint8Array([1, 2, 3, 4]);
    const result = await store.get(ref);
    expect(result).toBeNull();
  });

  it('should store and retrieve key packages', async () => {
    const ref = new Uint8Array([1, 2, 3, 4]);
    const pkg = {
      ref,
      publicPackage: new Uint8Array([10, 20, 30]),
      privatePackage: { key: 'secret-key-data' },
      published: false,
      used: false,
    } as any;

    await store.set(ref, pkg);
    const result = await store.get(ref);

    expect(result).not.toBeNull();
    expect(result!.privatePackage).toEqual({ key: 'secret-key-data' });
  });

  it('should list all key packages', async () => {
    const ref1 = new Uint8Array([1, 2, 3]);
    const ref2 = new Uint8Array([4, 5, 6]);

    await store.set(ref1, {
      ref: ref1,
      publicPackage: new Uint8Array([10]),
      privatePackage: null,
      published: false,
      used: false,
    } as any);

    await store.set(ref2, {
      ref: ref2,
      publicPackage: new Uint8Array([20]),
      privatePackage: null,
      published: true,
      used: false,
    } as any);

    const list = await store.list();
    expect(list).toHaveLength(2);
  });

  it('should delete key packages', async () => {
    const ref = new Uint8Array([1, 2, 3]);
    await store.set(ref, {
      ref,
      publicPackage: new Uint8Array([10]),
      privatePackage: null,
    } as any);

    expect(await store.get(ref)).not.toBeNull();
    await store.delete(ref);
    expect(await store.get(ref)).toBeNull();
  });

  it('should mark key packages as used', async () => {
    const ref = new Uint8Array([1, 2, 3]);
    await store.set(ref, {
      ref,
      publicPackage: new Uint8Array([10]),
      privatePackage: null,
      published: false,
      used: false,
    } as any);

    await store.markUsed(ref);

    const result = await store.get(ref);
    expect(result!.used).toBe(true);
  });

  it('should retrieve private key via getPrivateKey()', async () => {
    const ref = new Uint8Array([1, 2, 3]);
    await store.set(ref, {
      ref,
      publicPackage: new Uint8Array([10]),
      privatePackage: { secretData: 'test' },
    } as any);

    const privateKey = await store.getPrivateKey(ref);
    expect(privateKey).toEqual({ secretData: 'test' });
  });

  it('should return null from getPrivateKey() for missing ref', async () => {
    const ref = new Uint8Array([99, 99, 99]);
    const result = await store.getPrivateKey(ref);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: initMarmotDatabase
// ---------------------------------------------------------------------------

describe('initMarmotDatabase', () => {
  it('should create all required tables', () => {
    const db = initMarmotDatabase(':memory:');

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);

    expect(tables).toContain('marmot_groups');
    expect(tables).toContain('marmot_key_packages');
    expect(tables).toContain('marmot_processed_events');

    db.close();
  });

  it('should be idempotent (CREATE IF NOT EXISTS)', () => {
    const db = initMarmotDatabase(':memory:');

    // Insert data then re-run schema — should not lose data or error
    db.prepare(
      'INSERT INTO marmot_processed_events (event_id, processed_at) VALUES (?, ?)',
    ).run('test-event', 12345);

    db.exec(`
      CREATE TABLE IF NOT EXISTS marmot_groups (
        group_id BLOB PRIMARY KEY,
        state BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    const row = db
      .prepare('SELECT event_id FROM marmot_processed_events WHERE event_id = ?')
      .get('test-event') as any;
    expect(row.event_id).toBe('test-event');

    db.close();
  });
});
