import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  stopSession,
  hasSession,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('stopSession', () => {
  it('returns tmux kill-session command', () => {
    expect(stopSession('nanoclaw-test-123')).toBe(
      'tmux kill-session -t nanoclaw-test-123',
    );
  });
});

describe('hasSession', () => {
  it('returns true when session exists', () => {
    mockExecSync.mockReturnValueOnce('');
    expect(hasSession('nanoclaw-test-123')).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      'tmux has-session -t nanoclaw-test-123',
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it('returns false when session does not exist', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('session not found');
    });
    expect(hasSession('nanoclaw-test-123')).toBe(false);
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when tmux is available', () => {
    mockExecSync.mockReturnValueOnce('tmux 3.4');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith('tmux -V', {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith('Tmux runtime available');
  });

  it('throws when tmux is not found', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('tmux: command not found');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'tmux is required but not found',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw tmux sessions', () => {
    // tmux list-sessions returns session names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    // kill-session calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // list-sessions + 2 kill-session calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      'tmux kill-session -t nanoclaw-group1-111',
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      'tmux kill-session -t nanoclaw-group2-222',
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned tmux sessions',
    );
  });

  it('ignores non-nanoclaw sessions', () => {
    mockExecSync.mockReturnValueOnce(
      'my-other-session\nnanoclaw-group1-111\nwork-session\n',
    );
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // list-sessions + 1 kill-session (only nanoclaw- prefixed)
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      'tmux kill-session -t nanoclaw-group1-111',
      { stdio: 'pipe' },
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when list-sessions fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('tmux not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned sessions',
    );
  });

  it('continues stopping remaining sessions when one kill fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First kill fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second kill succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned tmux sessions',
    );
  });
});
