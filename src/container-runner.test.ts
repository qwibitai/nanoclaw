import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  AGENT_CLI_BIN: 'claude',
  AGENT_RUNNER_BACKEND: 'claude',
  AUTO_COMPACT_ENABLED: false,
  AUTO_COMPACT_THRESHOLD: 0.8,
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
const mockChildLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockChildLogger),
  bindings: vi.fn(() => ({ correlationId: 'test-corr-id' })),
};
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => mockChildLogger),
  },
  generateCorrelationId: vi.fn(() => 'test-corr-id'),
  createCorrelationLogger: vi.fn(() => mockChildLogger),
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false, size: 0 })),
      copyFileSync: vi.fn(),
      openSync: vi.fn(() => 99),
      readSync: vi.fn(() => 0),
      closeSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  hasSession: vi.fn(() => false),
  stopSession: vi.fn((name: string) => `tmux kill-session -t ${name}`),
}));

// Mock child_process
const mockExecSync = vi.fn();
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execSync: (...args: unknown[]) => mockExecSync(...args),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return {};
      },
    ),
  };
});

import fs from 'fs';
import {
  buildVolumeMounts,
  runContainerAgent,
  ContainerOutput,
} from './container-runner.js';
import { hasSession } from './container-runtime.js';
import type { RegisteredGroup } from './types.js';
import fsActual from 'fs';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

describe('tmux session runner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    // Mock agent-runner dist exists
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (String(p).includes('agent-runner/dist/index.js')) return true;
      return false;
    });
    mockExecSync.mockReturnValue('');
    vi.mocked(hasSession).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns tmux session and detects completion', async () => {
    // hasSession returns true initially, then false (session ended)
    let pollCount = 0;
    vi.mocked(hasSession).mockImplementation(() => {
      pollCount++;
      return pollCount <= 2;
    });

    // Simulate output file containing sentinel markers
    const outputData = `${OUTPUT_START_MARKER}\n{"status":"success","result":"hello","newSessionId":"sess-1"}\n${OUTPUT_END_MARKER}\n`;
    let statCalls = 0;
    vi.mocked(fs.statSync).mockImplementation(() => {
      statCalls++;
      return {
        size: statCalls > 1 ? outputData.length : 0,
        isDirectory: () => false,
      } as fs.Stats;
    });
    vi.mocked(fs.openSync).mockReturnValue(99);
    vi.mocked(fs.readSync).mockImplementation(
      (_fd, buffer: ArrayBufferView) => {
        const data = Buffer.from(outputData);
        data.copy(
          Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength),
        );
        return data.length;
      },
    );

    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Advance timers to allow polling
    await vi.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('sess-1');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'hello' }),
    );

    // Verify tmux new-session was called
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('tmux new-session -d -s nanoclaw-test-group-'),
      expect.any(Object),
    );
  });

  it('timeout with no output resolves as error', async () => {
    // Session stays alive until timeout
    vi.mocked(hasSession).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({
      size: 0,
      isDirectory: () => false,
    } as fs.Stats);

    const resultPromise = runContainerAgent(testGroup, testInput, () => {});

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Session killed, now returns false
    vi.mocked(hasSession).mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
  });
});

describe('buildVolumeMounts MCP credential mounts', () => {
  const mockedFs = vi.mocked(fsActual);

  beforeEach(() => {
    mockedFs.existsSync.mockImplementation((p: fsActual.PathLike) => {
      const s = String(p);
      if (s.includes('.gmail-mcp') || s.includes('.x-mcp')) return true;
      return false;
    });
    mockedFs.mkdirSync.mockReturnValue(undefined);
    mockedFs.writeFileSync.mockReturnValue(undefined);
    mockedFs.readdirSync.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes MCP credential mounts for interactive containers', () => {
    const group: RegisteredGroup = {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      containerConfig: {
        mcpCredentialMounts: [
          { hostPath: '~/.gmail-mcp' },
          { hostPath: '~/.x-mcp', name: 'x-credentials' },
        ],
      },
    };

    const mounts = buildVolumeMounts(group, false);
    const mcpMounts = mounts.filter((m) =>
      m.containerPath.startsWith('/workspace/mcp-credentials/'),
    );

    expect(mcpMounts).toHaveLength(2);
    expect(mcpMounts[0].containerPath).toBe(
      '/workspace/mcp-credentials/.gmail-mcp',
    );
    expect(mcpMounts[0].readonly).toBe(true);
    expect(mcpMounts[1].containerPath).toBe(
      '/workspace/mcp-credentials/x-credentials',
    );
    expect(mcpMounts[1].readonly).toBe(true);
  });

  it('includes MCP credential mounts for scheduled-task containers', () => {
    const group: RegisteredGroup = {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      containerConfig: {
        mcpCredentialMounts: [{ hostPath: '~/.gmail-mcp' }],
      },
    };

    const mounts = buildVolumeMounts(group, true);
    const mcpMounts = mounts.filter((m) =>
      m.containerPath.startsWith('/workspace/mcp-credentials/'),
    );

    expect(mcpMounts).toHaveLength(1);
    expect(mcpMounts[0].containerPath).toBe(
      '/workspace/mcp-credentials/.gmail-mcp',
    );
    expect(mcpMounts[0].readonly).toBe(true);
  });

  it('skips MCP credential mounts when host path does not exist', () => {
    mockedFs.existsSync.mockReturnValue(false);

    const group: RegisteredGroup = {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      containerConfig: {
        mcpCredentialMounts: [{ hostPath: '~/.nonexistent-mcp' }],
      },
    };

    const mounts = buildVolumeMounts(group, false);
    const mcpMounts = mounts.filter((m) =>
      m.containerPath.startsWith('/workspace/mcp-credentials/'),
    );

    expect(mcpMounts).toHaveLength(0);
  });

  it('produces identical MCP mounts for interactive and scheduled paths', () => {
    const group: RegisteredGroup = {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
      containerConfig: {
        mcpCredentialMounts: [
          { hostPath: '~/.gmail-mcp' },
          { hostPath: '~/.x-mcp', name: 'x-creds' },
        ],
      },
    };

    const interactiveMounts = buildVolumeMounts(group, false);
    const scheduledMounts = buildVolumeMounts(group, false);

    const interactiveMcp = interactiveMounts.filter((m) =>
      m.containerPath.startsWith('/workspace/mcp-credentials/'),
    );
    const scheduledMcp = scheduledMounts.filter((m) =>
      m.containerPath.startsWith('/workspace/mcp-credentials/'),
    );

    expect(interactiveMcp).toEqual(scheduledMcp);
  });

  it('works when no MCP credential mounts are configured', () => {
    const group: RegisteredGroup = {
      name: 'Test Group',
      folder: 'test-group',
      trigger: '@Andy',
      added_at: new Date().toISOString(),
    };

    const mounts = buildVolumeMounts(group, false);
    const mcpMounts = mounts.filter((m) =>
      m.containerPath.startsWith('/workspace/mcp-credentials/'),
    );

    expect(mcpMounts).toHaveLength(0);
  });
});
