import { describe, it, expect, vi } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock config
vi.mock('./config.js', () => ({
  GROUPS_DIR: '/tmp/nc-cleanup-test-nonexistent',
}));

import { startAttachmentCleanup } from './attachment-cleanup.js';

describe('startAttachmentCleanup', () => {
  it('exports a function', () => {
    expect(typeof startAttachmentCleanup).toBe('function');
  });
});
