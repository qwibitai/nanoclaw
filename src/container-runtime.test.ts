import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock os.platform so we can exercise both Linux and non-Linux branches.
const mockPlatform: () => NodeJS.Platform = vi.fn(() => 'linux' as NodeJS.Platform);
vi.mock('os', () => ({
  default: {
    get platform() {
      return mockPlatform;
    },
  },
  platform: () => mockPlatform(),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  hostGatewayArgs,
  getOnecliBridgeIp,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockPlatform).mockReturnValue('linux');
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
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
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('filters ps by the install label so peers are not reaped', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.any(Object),
    );
  });

  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce('nanoclaw-group1-111\nnanoclaw-group2-222\n');
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`, {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });
});

describe('hostGatewayArgs', () => {
  it('returns empty on non-Linux platforms (host.docker.internal is built-in)', () => {
    vi.mocked(mockPlatform).mockReturnValue('darwin');
    expect(hostGatewayArgs()).toEqual([]);
    expect(hostGatewayArgs({ onecliBridgeIp: '172.17.0.2' })).toEqual([]);
  });

  it('falls back to host-gateway on Linux when no OneCLI IP is provided', () => {
    expect(hostGatewayArgs()).toEqual(['--add-host=host.docker.internal:host-gateway']);
    expect(hostGatewayArgs({ onecliBridgeIp: null })).toEqual(['--add-host=host.docker.internal:host-gateway']);
  });

  it('pins host.docker.internal to the OneCLI bridge IP when provided', () => {
    expect(hostGatewayArgs({ onecliBridgeIp: '172.17.0.2' })).toEqual(['--add-host=host.docker.internal:172.17.0.2']);
  });
});

describe('getOnecliBridgeIp', () => {
  it('returns the IPv4 address when docker inspect prints one', () => {
    mockExecSync.mockReturnValueOnce('172.17.0.2\n');
    expect(getOnecliBridgeIp()).toBe('172.17.0.2');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('inspect onecli'),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' }),
    );
  });

  it('returns null when OneCLI is not on the bridge network (empty inspect output)', () => {
    mockExecSync.mockReturnValueOnce('\n');
    expect(getOnecliBridgeIp()).toBeNull();
  });

  it('returns null when docker inspect emits the literal "<no value>"', () => {
    // Go template prints "<no value>" when the indexed key is missing.
    mockExecSync.mockReturnValueOnce('<no value>\n');
    expect(getOnecliBridgeIp()).toBeNull();
  });

  it('returns null when docker inspect throws (OneCLI not running)', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('No such container: onecli');
    });
    expect(getOnecliBridgeIp()).toBeNull();
  });
});
