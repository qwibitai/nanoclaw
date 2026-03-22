import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';

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
  detectContainerRuntimeBin,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  getContainerHostGateway,
  getProxyBindHost,
  getRuntimeErrorGuidance,
  getRuntimeStartCommand,
  getRuntimeStatusCommand,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete process.env.CONTAINER_RUNTIME_BIN;
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
  it('returns stop command using the detected runtime', () => {
    expect(stopContainer('nanoclaw-test-123')).toBe(
      `${detectContainerRuntimeBin()} stop nanoclaw-test-123`,
    );
  });
});

describe('runtime selection', () => {
  it('defaults to Apple Container on macOS', () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    delete process.env.CONTAINER_RUNTIME_BIN;

    expect(detectContainerRuntimeBin()).toBe('container');
  });

  it('defaults to Docker on Linux', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    delete process.env.CONTAINER_RUNTIME_BIN;

    expect(detectContainerRuntimeBin()).toBe('docker');
  });

  it('prefers CONTAINER_RUNTIME_BIN override', () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
    process.env.CONTAINER_RUNTIME_BIN = 'docker';

    expect(detectContainerRuntimeBin()).toBe('docker');
  });
});

describe('Apple Container network addressing', () => {
  beforeEach(() => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
  });

  it('uses the bridge100 IPv4 address for the proxy bind host on macOS', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      bridge100: [
        {
          address: '192.168.64.1',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '192.168.64.1/24',
        },
      ],
    });

    expect(getProxyBindHost()).toBe('192.168.64.1');
  });

  it('uses the bridge100 IPv4 address as the Apple Container host gateway', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      bridge100: [
        {
          address: '192.168.64.1',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: '00:00:00:00:00:00',
          internal: false,
          cidr: '192.168.64.1/24',
        },
      ],
    });

    expect(getContainerHostGateway()).toBe('192.168.64.1');
  });

  it('keeps loopback on WSL', () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    vi.spyOn(fs, 'existsSync').mockImplementation(
      (target) => target === '/proc/sys/fs/binfmt_misc/WSLInterop',
    );

    expect(getProxyBindHost()).toBe('127.0.0.1');
  });
});

describe('runtime commands', () => {
  it('uses container system status/start for Apple Container', () => {
    expect(getRuntimeStatusCommand('container')).toEqual({
      command: 'container system status',
      timeout: 30000,
    });
    expect(getRuntimeStartCommand('container')).toEqual({
      command: 'container system start',
      timeout: 30000,
    });
  });

  it('uses docker info and no start command for Docker', () => {
    expect(getRuntimeStatusCommand('docker')).toEqual({
      command: 'docker info',
      timeout: 10000,
    });
    expect(getRuntimeStartCommand('docker')).toBeNull();
  });

  it('returns runtime-specific failure guidance', () => {
    expect(getRuntimeErrorGuidance('container')).toContain(
      'Ensure Apple Container is installed',
    );
    expect(getRuntimeErrorGuidance('docker')).toContain(
      'Ensure docker is installed and running',
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  beforeEach(() => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
  });

  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith('container system status', {
      stdio: 'pipe',
      timeout: 30000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
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
    expect(mockExecSync).toHaveBeenNthCalledWith(2, 'container system start', {
      stdio: 'pipe',
      timeout: 30000,
    });
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
  beforeEach(() => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin');
  });

  it('stops orphaned nanoclaw containers from JSON output', () => {
    // Apple Container ls returns JSON
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-group1-111' } },
      { status: 'stopped', configuration: { id: 'nanoclaw-group2-222' } },
      { status: 'running', configuration: { id: 'nanoclaw-group3-333' } },
      { status: 'running', configuration: { id: 'other-container' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ls + 2 stop calls (only running nanoclaw- containers)
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      'container stop nanoclaw-group1-111',
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      'container stop nanoclaw-group3-333',
      { stdio: 'pipe' },
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
    mockExecSync.mockReturnValueOnce(lsOutput);
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
});
