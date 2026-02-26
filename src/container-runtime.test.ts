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

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_NAME_PREFIX: 'nanoclaw-testuser',
}));

// Mock fs for detectDockerSocket tests
const mockStatSync = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: { ...actual, statSync: (...args: unknown[]) => mockStatSync(...args) },
  };
});

// Mock child_process — store the mock fns so tests can configure them
const mockExecSync = vi.fn();
const mockExec = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  exec: (...args: unknown[]) => mockExec(...args),
}));

// Mock util.promisify — vi.hoisted ensures the fn exists before vi.mock runs
const mockExecAsync = vi.hoisted(() => vi.fn());
vi.mock('util', () => ({
  promisify: () => mockExecAsync,
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  stopContainerAsync,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  isRootlessDocker,
  detectDockerSocket,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('returns stop command using CONTAINER_RUNTIME_BIN', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
    );
  });
});

// --- stopContainerAsync ---

describe('stopContainerAsync', () => {
  it('stops a container with default timeout', async () => {
    mockExecAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await stopContainerAsync('nanoclaw-test-123');

    expect(mockExecAsync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 10 nanoclaw-test-123`,
    );
    expect(logger.info).toHaveBeenCalledWith(
      { name: 'nanoclaw-test-123' },
      'Container stopped',
    );
  });

  it('uses custom timeout', async () => {
    mockExecAsync.mockResolvedValueOnce({ stdout: '', stderr: '' });

    await stopContainerAsync('nanoclaw-test-456', 30);

    expect(mockExecAsync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 30 nanoclaw-test-456`,
    );
  });

  it('swallows "already stopped" errors', async () => {
    mockExecAsync.mockRejectedValueOnce(new Error('No such container: nanoclaw-test-789'));

    await stopContainerAsync('nanoclaw-test-789'); // should not throw

    expect(logger.debug).toHaveBeenCalledWith(
      { name: 'nanoclaw-test-789' },
      'Container already stopped',
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} info`,
      { stdio: 'pipe', timeout: 10000 },
    );
    expect(logger.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
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
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce('nanoclaw-testuser-group1-111\nnanoclaw-testuser-group2-222\n');
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-testuser-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-testuser-group2-222`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-testuser-group1-111', 'nanoclaw-testuser-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-testuser-a-1\nnanoclaw-testuser-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-testuser-a-1', 'nanoclaw-testuser-b-2'] },
      'Stopped orphaned containers',
    );
  });

  it('filters by instance prefix', () => {
    mockExecSync.mockReturnValueOnce('');
    cleanupOrphans();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('--filter name=nanoclaw-testuser-'),
      expect.any(Object),
    );
  });
});

// --- isRootlessDocker ---

describe('isRootlessDocker', () => {
  it('detects rootless mode and caches result', () => {
    mockExecSync.mockReturnValueOnce('["name=seccomp,profile=default","name=rootless"]');

    const result = isRootlessDocker();
    expect(result).toBe(true);

    // Second call should use cache (no additional execSync calls)
    const callCount = mockExecSync.mock.calls.length;
    const result2 = isRootlessDocker();
    expect(result2).toBe(true);
    expect(mockExecSync).toHaveBeenCalledTimes(callCount);
  });
});

// --- detectDockerSocket ---

describe('detectDockerSocket', () => {
  it('finds standard rootful socket and caches result', () => {
    // No XDG_RUNTIME_DIR set, getuid returns 0 (root) — falls through to /var/run/docker.sock
    mockStatSync.mockImplementation((p: string) => {
      if (p === '/var/run/docker.sock') return { gid: 999 };
      throw new Error('ENOENT');
    });

    const result = detectDockerSocket();
    expect(result).toBe('/var/run/docker.sock');

    // Second call should use cache
    const callCount = mockStatSync.mock.calls.length;
    const result2 = detectDockerSocket();
    expect(result2).toBe('/var/run/docker.sock');
    expect(mockStatSync).toHaveBeenCalledTimes(callCount);
  });
});
