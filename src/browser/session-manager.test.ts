import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../config.js', () => ({
  BROWSER_MAX_CONTEXTS: 3,
  BROWSER_MAX_PAGES: 2,
  BROWSER_IDLE_TIMEOUT_MS: 600_000,
  BROWSER_ACQUIRE_TIMEOUT_MS: 30_000,
  BROWSER_CDP_URL: 'http://test:9222',
  BROWSER_PROFILE_DIR: 'browser',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock PlaywrightClient
const mockContext = {
  close: vi.fn(),
  newPage: vi.fn(() => Promise.resolve({ close: vi.fn() })),
  pages: vi.fn(() => []),
  storageState: vi.fn(() => Promise.resolve({ cookies: [], origins: [] })),
};

const mockClient = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnected: vi.fn(() => true),
  newContext: vi.fn(() =>
    Promise.resolve({
      close: vi.fn(),
      newPage: vi.fn(() => Promise.resolve({ close: vi.fn() })),
      pages: vi.fn(() => []),
      storageState: mockContext.storageState,
    }),
  ),
  setOnDisconnect: vi.fn(),
};

vi.mock('./playwright-client.js', () => ({
  PlaywrightClient: vi.fn(function () {
    return mockClient;
  }),
}));

import { BrowserSessionManager } from './session-manager.js';

describe('BrowserSessionManager (pool-based)', () => {
  let manager: BrowserSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new BrowserSessionManager();
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  describe('acquireContext', () => {
    it('creates a new context for a group', async () => {
      const ctx = await manager.acquireContext('group-1');
      expect(ctx).toBeDefined();
      expect(mockClient.newContext).toHaveBeenCalled();
    });

    it('returns existing context for same group', async () => {
      const ctx1 = await manager.acquireContext('group-1');
      const ctx2 = await manager.acquireContext('group-1');
      expect(ctx1).toBe(ctx2);
      expect(mockClient.newContext).toHaveBeenCalledTimes(1);
    });

    it('creates separate contexts for different groups', async () => {
      await manager.acquireContext('group-1');
      await manager.acquireContext('group-2');
      expect(mockClient.newContext).toHaveBeenCalledTimes(2);
    });
  });

  describe('releaseContext', () => {
    it('closes context and exports storage state', async () => {
      await manager.acquireContext('group-1');
      await manager.releaseContext('group-1');
      expect(mockContext.storageState).toHaveBeenCalled();
    });

    it('is idempotent for unknown groups', async () => {
      await manager.releaseContext('nope'); // no throw
    });
  });

  describe('getActiveGroupIds', () => {
    it('returns empty array initially', () => {
      expect(manager.getActiveGroupIds()).toEqual([]);
    });

    it('tracks active groups', async () => {
      await manager.acquireContext('g1');
      await manager.acquireContext('g2');
      const ids = manager.getActiveGroupIds();
      expect(ids).toContain('g1');
      expect(ids).toContain('g2');
    });
  });

  describe('shutdown', () => {
    it('releases all contexts', async () => {
      await manager.acquireContext('g1');
      await manager.acquireContext('g2');
      await manager.shutdown();
      expect(manager.getActiveGroupIds()).toEqual([]);
    });
  });

  describe('profile persistence', () => {
    let tmpGroupsDir: string;

    beforeEach(() => {
      tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-groups-'));
    });

    afterEach(async () => {
      fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
    });

    it('saves storage state on releaseContext', async () => {
      const groupDir = path.join(tmpGroupsDir, 'test-group', 'browser');
      fs.mkdirSync(groupDir, { recursive: true });

      const mgr = new BrowserSessionManager(undefined, {
        profileKey: Buffer.alloc(32, 'a'),
        resolveProfileDir: (groupId) =>
          path.join(tmpGroupsDir, groupId, 'browser'),
      });

      await mgr.acquireContext('test-group');
      const state = await mgr.releaseContext('test-group');

      expect(state).not.toBeNull();
      expect(mockContext.storageState).toHaveBeenCalled();
      await mgr.shutdown();
    });
  });
});
