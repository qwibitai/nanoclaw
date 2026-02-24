import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExecSync, mockEmitStatus, mockLogger, mockFs, mockFsConstants, platformState } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockEmitStatus: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mockFs: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    accessSync: vi.fn(),
  },
  mockFsConstants: {
    F_OK: 0,
  },
  platformState: {
    platform: 'linux' as 'linux' | 'macos' | 'unknown',
    serviceManager: 'systemd' as 'systemd' | 'launchd' | 'none',
    runningAsRoot: false,
  },
}));

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock('fs', () => ({
  default: { ...mockFs, constants: mockFsConstants },
  ...mockFs,
  constants: mockFsConstants,
}));

vi.mock('os', () => ({
  default: {
    homedir: () => '/home/tester',
    userInfo: () => ({ username: 'tester' }),
  },
  homedir: () => '/home/tester',
  userInfo: () => ({ username: 'tester' }),
}));

vi.mock('../src/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('./status.js', () => ({
  emitStatus: (...args: unknown[]) => mockEmitStatus(...args),
}));

vi.mock('./platform.js', () => ({
  getPlatform: () => platformState.platform,
  getNodePath: () => '/usr/bin/node',
  getServiceManager: () => platformState.serviceManager,
  hasSystemd: () => true,
  isRoot: () => platformState.runningAsRoot,
  isWSL: () => false,
}));

import { run } from './service.js';

describe('setup service behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformState.platform = 'linux';
    platformState.serviceManager = 'systemd';
    platformState.runningAsRoot = false;
    // Default: docker socket exists at /var/run/docker.sock
    mockFs.accessSync.mockImplementation((path: string) => {
      if (path === '/run/docker.sock') throw new Error('ENOENT');
      if (path === '/var/run/docker.sock') return undefined;
      throw new Error('ENOENT');
    });
  });

  it('fails with user-facing remediation when docker group is stale and remediation fails', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'npm run build') return '';
      if (cmd === 'systemctl --user daemon-reload') return '';
      if (cmd.startsWith("pkill -f '")) return '';
      if (cmd === 'systemd-run --user --pipe --wait docker info') {
        throw new Error('permission denied');
      }
      if (cmd === 'docker info') return '';
      if (cmd === 'command -v setfacl') return '/usr/bin/setfacl';
      if (cmd === 'sudo -n setfacl -m u:tester:rw /var/run/docker.sock') {
        throw new Error('sudo password required');
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
      }) as never);

    await expect(run([])).rejects.toThrow('exit:1');

    expect(
      mockExecSync.mock.calls.some((args) => args[0] === 'systemctl --user start nanoclaw'),
    ).toBe(false);
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({
        STATUS: 'failed',
        ERROR: 'docker_group_stale',
        DOCKER_GROUP_STALE: true,
        DOCKER_SOCKET_PATH: '/var/run/docker.sock',
        ACL_FAILURE_REASON: 'sudo_failed',
      }),
    );

    exitSpy.mockRestore();
  });

  it('uses /run/docker.sock when available', async () => {
    // Override default: socket exists at /run/docker.sock
    mockFs.accessSync.mockImplementation((path: string) => {
      if (path === '/run/docker.sock') return undefined;
      throw new Error('ENOENT');
    });

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'npm run build') return '';
      if (cmd === 'systemctl --user daemon-reload') return '';
      if (cmd.startsWith("pkill -f '")) return '';
      if (cmd === 'systemd-run --user --pipe --wait docker info') {
        throw new Error('permission denied');
      }
      if (cmd === 'docker info') return '';
      if (cmd === 'command -v setfacl') return '/usr/bin/setfacl';
      if (cmd === 'sudo -n setfacl -m u:tester:rw /run/docker.sock') {
        throw new Error('sudo password required');
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
      }) as never);

    await expect(run([])).rejects.toThrow('exit:1');

    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({
        DOCKER_SOCKET_PATH: '/run/docker.sock',
      }),
    );

    exitSpy.mockRestore();
  });

  it('reports setfacl_missing when acl tools not installed', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'npm run build') return '';
      if (cmd === 'systemctl --user daemon-reload') return '';
      if (cmd.startsWith("pkill -f '")) return '';
      if (cmd === 'systemd-run --user --pipe --wait docker info') {
        throw new Error('permission denied');
      }
      if (cmd === 'docker info') return '';
      if (cmd === 'command -v setfacl') {
        throw new Error('setfacl not found');
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
      }) as never);

    await expect(run([])).rejects.toThrow('exit:1');

    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({
        STATUS: 'failed',
        ERROR: 'docker_group_stale',
        DOCKER_GROUP_STALE: true,
        ACL_FAILURE_REASON: 'setfacl_missing',
      }),
    );

    exitSpy.mockRestore();
  });

  it('continues to start service when stale docker group is remediated', async () => {
    let systemdDockerChecks = 0;

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'npm run build') return '';
      if (cmd === 'systemctl --user daemon-reload') return '';
      if (cmd.startsWith("pkill -f '")) return '';
      if (cmd === 'systemd-run --user --pipe --wait docker info') {
        systemdDockerChecks += 1;
        if (systemdDockerChecks === 1) throw new Error('permission denied');
        return '';
      }
      if (cmd === 'docker info') return '';
      if (cmd === 'command -v setfacl') return '/usr/bin/setfacl';
      if (cmd === 'sudo -n setfacl -m u:tester:rw /var/run/docker.sock') return '';
      if (cmd === 'systemctl --user enable nanoclaw') return '';
      if (cmd === 'systemctl --user start nanoclaw') return '';
      if (cmd === 'systemctl --user is-active nanoclaw') return '';
      throw new Error(`Unexpected command: ${cmd}`);
    });

    await run([]);

    expect(
      mockExecSync.mock.calls.some((args) => args[0] === 'systemctl --user start nanoclaw'),
    ).toBe(true);
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({
        STATUS: 'success',
      }),
    );
  });

  it('keeps macOS launchd path unaffected', async () => {
    platformState.platform = 'macos';
    platformState.serviceManager = 'launchd';

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'npm run build') return '';
      if (cmd.startsWith('launchctl load ')) return '';
      if (cmd === 'launchctl list') return '123\t0\tcom.nanoclaw\n';
      throw new Error(`Unexpected command: ${cmd}`);
    });

    await run([]);

    expect(mockExecSync.mock.calls.some((args) => String(args[0]).includes('systemd-run'))).toBe(
      false,
    );
    expect(mockExecSync.mock.calls.some((args) => String(args[0]).includes('setfacl'))).toBe(
      false,
    );
    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({
        SERVICE_TYPE: 'launchd',
        STATUS: 'success',
      }),
    );
  });

  it('fails when systemd service is not active after start attempt', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'npm run build') return '';
      if (cmd === 'systemctl --user daemon-reload') return '';
      if (cmd.startsWith("pkill -f '")) return '';
      if (cmd === 'systemd-run --user --pipe --wait docker info') return '';
      if (cmd === 'systemctl --user enable nanoclaw') return '';
      if (cmd === 'systemctl --user start nanoclaw') {
        throw new Error('failed to start');
      }
      if (cmd === 'systemctl --user is-active nanoclaw') {
        throw new Error('inactive');
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
      }) as never);

    await expect(run([])).rejects.toThrow('exit:1');

    expect(mockEmitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({
        STATUS: 'failed',
        ERROR: 'service_not_active',
      }),
    );

    exitSpy.mockRestore();
  });
});
