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

// Mock child_process
const mockExecSync = vi.fn();
const mockSpawnSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Default spawnSync to return empty stdout
  mockSpawnSync.mockReturnValue({ stdout: '', stderr: '', status: 0 });
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop via spawnSync for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockSpawnSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-test-123'],
      { stdio: 'pipe', timeout: 10_000 },
    );
  });

  it('accepts names with dots and underscores', () => {
    stopContainer('nanoclaw-my_group.test-123');
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('falls back to docker kill when docker stop fails', () => {
    mockSpawnSync.mockReturnValueOnce({ stdout: '', stderr: '', status: 1 });
    mockSpawnSync.mockReturnValueOnce({ stdout: '', stderr: '', status: 0 });

    stopContainer('nanoclaw-test-123');

    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      1,
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-test-123'],
      { stdio: 'pipe', timeout: 10_000 },
    );
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      2,
      CONTAINER_RUNTIME_BIN,
      ['kill', 'nanoclaw-test-123'],
      { stdio: 'pipe', timeout: 5_000 },
    );
  });

  it('falls back to docker kill when docker stop times out (status null)', () => {
    mockSpawnSync.mockReturnValueOnce({ stdout: '', stderr: '', status: null });
    mockSpawnSync.mockReturnValueOnce({ stdout: '', stderr: '', status: 0 });

    stopContainer('nanoclaw-test-123');

    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      1,
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-test-123'],
      { stdio: 'pipe', timeout: 10_000 },
    );
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      2,
      CONTAINER_RUNTIME_BIN,
      ['kill', 'nanoclaw-test-123'],
      { stdio: 'pipe', timeout: 5_000 },
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not running');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    mockSpawnSync.mockReturnValueOnce({
      stdout: 'nanoclaw-group1-111\nnanoclaw-group2-222\nother-container\n',
      stderr: '',
      status: 0,
    });

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockSpawnSync).toHaveBeenCalledTimes(3);
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      2,
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-group1-111'],
      { stdio: 'pipe', timeout: 10_000 },
    );
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      3,
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', 'nanoclaw-group2-222'],
      { stdio: 'pipe', timeout: 10_000 },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockSpawnSync.mockReturnValueOnce({ stdout: '\n', stderr: '', status: 0 });

    cleanupOrphans();

    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockSpawnSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockSpawnSync.mockReturnValueOnce({
      stdout: 'nanoclaw-a-1\nnanoclaw-b-2\n',
      stderr: '',
      status: 0,
    });
    // First stop fails
    mockSpawnSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockSpawnSync.mockReturnValueOnce({ stdout: '', stderr: '', status: 0 });

    cleanupOrphans(); // should not throw

    expect(mockSpawnSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});
