import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.NANOCLAW_CONTAINER_RUNTIME;
});

afterEach(() => {
  delete process.env.NANOCLAW_CONTAINER_RUNTIME;
});

async function importRuntime() {
  vi.resetModules();
  return import('./container-runtime.js');
}

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', async () => {
    const { readonlyMountArgs } = await importRuntime();
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });

  it('returns no mount flags in containerless mode', async () => {
    process.env.NANOCLAW_CONTAINER_RUNTIME = 'none';
    const { readonlyMountArgs } = await importRuntime();
    expect(readonlyMountArgs('/host/path', '/container/path')).toEqual([]);
  });
});

describe('stopContainer', () => {
  it('returns stop command using CONTAINER_RUNTIME_BIN', async () => {
    const { CONTAINER_RUNTIME_BIN, stopContainer } = await importRuntime();
    expect(stopContainer('nanoclaw-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', async () => {
    const { CONTAINER_RUNTIME_BIN, ensureContainerRuntimeRunning } =
      await importRuntime();
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

  it('throws when docker info fails', async () => {
    const { ensureContainerRuntimeRunning } = await importRuntime();
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });

  it('skips runtime checks in containerless mode', async () => {
    process.env.NANOCLAW_CONTAINER_RUNTIME = 'none';
    const { ensureContainerRuntimeRunning } = await importRuntime();

    ensureContainerRuntimeRunning();

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Containerless mode: skipping container runtime check',
    );
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', async () => {
    const { CONTAINER_RUNTIME_BIN, cleanupOrphans } = await importRuntime();
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', async () => {
    const { cleanupOrphans } = await importRuntime();
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', async () => {
    const { cleanupOrphans } = await importRuntime();
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', async () => {
    const { cleanupOrphans } = await importRuntime();
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });

  it('skips orphan cleanup in containerless mode', async () => {
    process.env.NANOCLAW_CONTAINER_RUNTIME = 'none';
    const { cleanupOrphans } = await importRuntime();

    cleanupOrphans();

    expect(mockExecSync).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Containerless mode: skipping orphan cleanup',
    );
  });
});
