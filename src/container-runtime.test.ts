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
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  stopContainerWithVerification,
  stopRunningContainersByPrefix,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns --mount flag with type=bind and readonly', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual([
      '--mount',
      'type=bind,source=/host/path,target=/container/path,readonly',
    ]);
  });
});

describe('stopContainer', () => {
  it('returns stop command using CONTAINER_RUNTIME_BIN', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-test-123`,
    );
  });
});

describe('stopContainerWithVerification', () => {
  it('returns stopped=true when stop succeeds and verify shows not running', () => {
    // stop command succeeds
    mockExecSync.mockReturnValueOnce('');
    // verify list
    mockExecSync.mockReturnValueOnce('[]');

    const result = stopContainerWithVerification('nanoclaw-test-123');

    expect(result.stopped).toBe(true);
    expect(result.attempts.some((a) => a.includes('verified stopped'))).toBe(true);
  });

  it('escalates through stop/kill commands when container remains running', () => {
    // stop
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('stop failed');
    });
    // verify still running
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        { status: 'running', configuration: { id: 'nanoclaw-test-123' } },
      ]),
    );
    // stop -s SIGKILL -t 1
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('sigkill stop failed');
    });
    // verify still running
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        { status: 'running', configuration: { id: 'nanoclaw-test-123' } },
      ]),
    );
    // kill succeeds
    mockExecSync.mockReturnValueOnce('');
    // verify stopped
    mockExecSync.mockReturnValueOnce('[]');

    const result = stopContainerWithVerification('nanoclaw-test-123');

    expect(result.stopped).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -s SIGKILL -t 1 nanoclaw-test-123`,
      { stdio: 'pipe', timeout: 10000 },
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} kill nanoclaw-test-123`,
      { stdio: 'pipe', timeout: 10000 },
    );
  });
});

describe('stopRunningContainersByPrefix', () => {
  it('stops only running containers that match prefix', () => {
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-andy-1' } },
      { status: 'stopped', configuration: { id: 'nanoclaw-andy-2' } },
      { status: 'running', configuration: { id: 'nanoclaw-jarvis-1' } },
    ]);
    mockExecSync
      .mockReturnValueOnce(lsOutput) // initial ls
      .mockReturnValueOnce('') // stop andy-1
      .mockReturnValueOnce(
        JSON.stringify([
          { status: 'running', configuration: { id: 'nanoclaw-jarvis-1' } },
        ]),
      ); // verify andy-1 stopped

    const result = stopRunningContainersByPrefix('nanoclaw-andy-');

    expect(result.matched).toEqual(['nanoclaw-andy-1']);
    expect(result.stopped).toEqual(['nanoclaw-andy-1']);
    expect(result.failures).toEqual([]);
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} system status`,
      { stdio: 'pipe' },
    );
    expect(logger.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('auto-starts when system status fails', () => {
    // First call (system status) fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });
    // Second call (system start) succeeds
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} system start`,
      { stdio: 'pipe', timeout: 30000 },
    );
    expect(logger.info).toHaveBeenCalledWith('Container runtime started');
  });

  it('throws when both status and start fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('failed');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers from JSON output', () => {
    // Apple Container ls returns JSON
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-group1-111' } },
      { status: 'stopped', configuration: { id: 'nanoclaw-group2-222' } },
      { status: 'running', configuration: { id: 'nanoclaw-group3-333' } },
      { status: 'running', configuration: { id: 'other-container' } },
    ]);
    mockExecSync
      .mockReturnValueOnce(lsOutput) // initial ls
      .mockReturnValueOnce('') // stop group1
      .mockReturnValueOnce('[]') // verify group1 stopped
      .mockReturnValueOnce('') // stop group3
      .mockReturnValueOnce('[]'); // verify group3 stopped

    cleanupOrphans();

    // initial ls + (stop+verify)*2
    expect(mockExecSync).toHaveBeenCalledTimes(5);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group1-111`,
      { stdio: 'pipe', timeout: 10000 },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      4,
      `${CONTAINER_RUNTIME_BIN} stop nanoclaw-group3-333`,
      { stdio: 'pipe', timeout: 10000 },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group3-333'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('[]');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ls fails', () => {
    // JSON listing fails, fallback table listing fails too
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container not available');
    });
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-a-1' } },
      { status: 'running', configuration: { id: 'nanoclaw-b-2' } },
    ]);
    mockExecSync
      .mockReturnValueOnce(lsOutput) // initial ls
      .mockImplementationOnce(() => {
        throw new Error('stop failed');
      }) // stop a
      .mockReturnValueOnce(lsOutput) // verify a still running
      .mockImplementationOnce(() => {
        throw new Error('sigkill stop failed');
      }) // stop -s SIGKILL a
      .mockReturnValueOnce(lsOutput) // verify a still running
      .mockImplementationOnce(() => {
        throw new Error('kill failed');
      }) // kill a
      .mockReturnValueOnce(lsOutput) // verify a still running
      .mockReturnValueOnce('') // stop b
      .mockReturnValueOnce(
        JSON.stringify([
          { status: 'running', configuration: { id: 'nanoclaw-a-1' } },
        ]),
      ); // verify b stopped, a still running

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(9);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 1, names: ['nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        failures: [
          expect.objectContaining({ name: 'nanoclaw-a-1' }),
        ],
      }),
      'Failed to stop some orphaned containers',
    );
  });
});
