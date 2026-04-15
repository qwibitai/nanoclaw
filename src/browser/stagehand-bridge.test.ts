import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  BROWSER_CDP_URL: 'ws://test:9222',
  BROWSER_MAX_CONTEXTS: 3,
  BROWSER_MAX_PAGES: 2,
  BROWSER_IDLE_TIMEOUT_MS: 600_000,
  BROWSER_ACQUIRE_TIMEOUT_MS: 30_000,
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

const mockPage = {
  goto: vi.fn(),
  content: vi.fn(() => '<html>test</html>'),
  close: vi.fn(),
};

const mockContext = {
  newPage: vi.fn(() => Promise.resolve(mockPage)),
  pages: vi.fn(() => [mockPage]),
  close: vi.fn(),
  storageState: vi.fn(() => Promise.resolve({ cookies: [], origins: [] })),
};

const mockSessionManager = {
  acquireContext: vi.fn(() => Promise.resolve(mockContext)),
  releaseContext: vi.fn(),
  getContext: vi.fn(() => mockContext),
};

import { StagehandBridge, type StagehandRequest } from './stagehand-bridge.js';

describe('StagehandBridge', () => {
  let bridge: StagehandBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new StagehandBridge(mockSessionManager as any);
  });

  describe('handleRequest', () => {
    it('rejects unknown request types', async () => {
      const result = await bridge.handleRequest({
        type: 'unknown' as any,
        instruction: 'test',
        groupId: 'g1',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown');
    });

    it('acquires context for the group', async () => {
      await bridge.handleRequest({
        type: 'observe',
        instruction: 'what is on this page?',
        groupId: 'g1',
      });
      expect(mockSessionManager.acquireContext).toHaveBeenCalledWith('g1');
    });
  });
});
