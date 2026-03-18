import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_NAME_PREFIX: 'nanoclaw-',
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  TIMEZONE: 'UTC',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs — include readFileSync and unlinkSync for readRouterResult
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      cpSync: vi.fn(),
      readFileSync: vi.fn(() => '{}'),
      unlinkSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
    },
  };
});

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: vi.fn(() => []),
  readonlyMountArgs: vi.fn((host: string, container: string) => [
    '-v',
    `${host}:${container}:ro`,
  ]),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

// Mock child_process
const mockSpawn = vi.fn();
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...args),
    execSync: vi.fn(() => ''),
  };
});

// Mock router-prompt
vi.mock('./router-prompt.js', () => ({
  buildRouterPrompt: vi.fn(
    () => 'You are a message router. Route this message.',
  ),
}));

import fs from 'fs';
import { readRouterResult } from './router-container.js';
import type { RouterRequest } from './router-types.js';

// Helper: create a mock container process
function createMockProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

function makeRouterRequest(
  overrides: Partial<RouterRequest> = {},
): RouterRequest {
  return {
    type: 'route',
    requestId: 'test-req-1',
    messageText: 'Fix the auth bug',
    senderName: 'Aviad',
    groupFolder: 'telegram_garsson',
    cases: [
      {
        id: 'case-1',
        name: '260315-1430-fix-auth',
        type: 'dev',
        status: 'active',
        description: 'Fix authentication flow',
        lastMessage: 'Working on OAuth redirect',
        lastActivityAt: '2025-03-17T11:30:00.000Z',
      },
      {
        id: 'case-2',
        name: '260316-0900-add-tests',
        type: 'dev',
        status: 'active',
        description: 'Add integration tests',
        lastMessage: null,
        lastActivityAt: null,
      },
    ],
    ...overrides,
  };
}

// Access the mocked fs default for use in tests
const mockFs = fs as unknown as {
  existsSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  cpSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  unlinkSync: ReturnType<typeof vi.fn>;
  readdirSync: ReturnType<typeof vi.fn>;
  statSync: ReturnType<typeof vi.fn>;
};

describe('readRouterResult', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * INVARIANT: readRouterResult reads and parses the IPC result file
   * SUT: readRouterResult
   * VERIFICATION: Structured decision is returned from file contents
   */
  it('reads structured decision from IPC file', () => {
    const decision = {
      requestId: 'req-1',
      decision: 'route_to_case',
      caseId: 'case-1',
      caseName: 'fix-auth',
      confidence: 0.9,
      reason: 'Auth related',
    };

    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(decision));

    const result = readRouterResult('req-1');

    expect(result.decision).toBe('route_to_case');
    expect(result.caseId).toBe('case-1');
    expect(result.confidence).toBe(0.9);
  });

  /**
   * INVARIANT: readRouterResult throws when no result files exist at all
   * SUT: readRouterResult error path
   * VERIFICATION: Error is thrown with descriptive message
   */
  it('throws when no result files exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readdirSync.mockReturnValue([]);

    expect(() => readRouterResult('req-missing')).toThrow('no result file');
  });

  /**
   * INVARIANT: When the expected result file doesn't exist but the agent wrote
   * a result with a different request_id, the fallback finds it.
   * SUT: readRouterResult fallback path
   * VERIFICATION: Reads from the most recent .json file in results dir
   */
  it('falls back to most recent result file when expected file is missing', () => {
    const decision = {
      requestId: 'agent-made-up-id',
      decision: 'route_to_case',
      caseId: 'case-1',
      caseName: 'fix-auth',
      confidence: 0.85,
      reason: 'Auth related',
    };

    // First call: expected file doesn't exist. Second call: resultsDir exists.
    mockFs.existsSync
      .mockReturnValueOnce(false) // expected file
      .mockReturnValueOnce(false) // retry 1
      .mockReturnValueOnce(false) // retry 2
      .mockReturnValueOnce(false) // retry 3
      .mockReturnValueOnce(false) // retry 4
      .mockReturnValueOnce(false) // retry 5
      .mockReturnValueOnce(false) // final check for expected file
      .mockReturnValueOnce(true); // resultsDir exists

    mockFs.readdirSync.mockReturnValue(['agent-made-up-id.json']);
    mockFs.statSync.mockReturnValue({ mtimeMs: Date.now() });
    mockFs.readFileSync.mockReturnValue(JSON.stringify(decision));

    const result = readRouterResult('route-1773738908605-pwnz');

    expect(result.decision).toBe('route_to_case');
    expect(result.caseId).toBe('case-1');
    expect(result.confidence).toBe(0.85);
  });

  /**
   * INVARIANT: Missing fields get safe defaults
   * SUT: readRouterResult default handling
   * VERIFICATION: Partial responses get filled with defaults
   */
  it('provides safe defaults for missing fields', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ reason: 'partial' }));

    const result = readRouterResult('req-partial');

    expect(result.requestId).toBe('req-partial');
    expect(result.decision).toBe('suggest_new');
    expect(result.confidence).toBe(0);
  });

  /**
   * INVARIANT: Result file is cleaned up after reading
   * SUT: readRouterResult cleanup
   * VERIFICATION: unlinkSync is called on the result file
   */
  it('cleans up result file after reading', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        decision: 'suggest_new',
        confidence: 0.3,
        reason: 'test',
      }),
    );

    readRouterResult('req-cleanup');

    expect(mockFs.unlinkSync).toHaveBeenCalled();
  });
});

describe('routeMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: fs mocks return true for existsSync (setup checks in runRouterContainer)
    mockFs.existsSync.mockReturnValue(true);
  });

  /**
   * INVARIANT: routeMessage spawns a container with minimal mounts (no group filesystem)
   * SUT: routeMessage container spawning
   * VERIFICATION: spawn is called with args that do NOT include group-specific mounts
   */
  it('spawns a container without group filesystem mounts', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const routeDecision = {
      requestId: 'test-req-1',
      decision: 'route_to_case',
      caseId: 'case-1',
      caseName: 'fix-auth',
      confidence: 0.85,
      reason: 'Auth-related message',
    };

    // readRouterResult will read from the IPC file after container exits
    mockFs.readFileSync.mockReturnValue(JSON.stringify(routeDecision));

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest();

    const routePromise = routeMessage(request);

    // Container exits cleanly — route_decision MCP tool wrote the result file
    mockProc.emit('close', 0);

    const result = await routePromise;

    expect(result.decision).toBe('route_to_case');
    expect(result.caseId).toBe('case-1');

    // Verify spawn was called
    expect(mockSpawn).toHaveBeenCalledOnce();
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];

    // Verify no group-specific mounts (no /workspace/project or /workspace/extra)
    const mountArgs = spawnArgs.join(' ');
    expect(mountArgs).not.toContain('/workspace/project');
    expect(mountArgs).not.toContain('/workspace/extra');

    // Verify it does mount the router-specific directories
    expect(mountArgs).toContain('/workspace/group');
    expect(mountArgs).toContain('/workspace/ipc');
    expect(mountArgs).toContain('/app/src');
  });

  /**
   * INVARIANT: Router timeout returns an error, does not hang
   * SUT: routeMessage timeout handling
   * VERIFICATION: Promise rejects after timeout period
   */
  it('rejects when container times out', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest();

    const routePromise = routeMessage(request);

    // Simulate non-zero exit (killed by timeout handler)
    mockProc.emit('close', 137);

    await expect(routePromise).rejects.toThrow('exited with code 137');
  });

  /**
   * INVARIANT: Router timeout rejects even if 'close' event never fires (zombie container)
   * SUT: runRouterContainer force-reject safety net
   * VERIFICATION: Promise rejects within grace period when container ignores SIGTERM/SIGKILL
   */
  it('force-rejects when container does not emit close after timeout', async () => {
    vi.useFakeTimers();

    const mockProc = createMockProcess();
    // Make kill() a no-op — container stays alive, never emits 'close'
    mockProc.kill = vi.fn();
    mockSpawn.mockReturnValue(mockProc);

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest();

    // Attach .catch immediately to prevent unhandled rejection
    const routePromise = routeMessage(request).catch((err: Error) => err);

    // Advance past the 60s timeout + 10s force-reject grace period
    await vi.advanceTimersByTimeAsync(70_000);

    const result = await routePromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('timed out');

    vi.useRealTimers();
  });

  /**
   * INVARIANT: When close fires after timeout, promise still rejects (no hang)
   * SUT: runRouterContainer settle guard
   * VERIFICATION: Double-settle is safe — first rejection wins
   */
  it('handles close event after timeout without error', async () => {
    vi.useFakeTimers();

    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest();

    // Attach .catch immediately to prevent unhandled rejection
    const routePromise = routeMessage(request).catch((err: Error) => err);

    // Advance past timeout — triggers kill + force-reject timer
    await vi.advanceTimersByTimeAsync(60_000);

    // Now close fires (container finally died) — should be safely ignored
    mockProc.emit('close', 137);

    // Advance past force-reject timer
    await vi.advanceTimersByTimeAsync(10_000);

    // Should still reject with timeout error (first settlement wins)
    const result = await routePromise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('timed out');

    vi.useRealTimers();
  });

  /**
   * INVARIANT: Router container error is propagated as rejection
   * SUT: routeMessage error handling
   * VERIFICATION: Container spawn errors are caught and re-thrown
   */
  it('rejects when container fails to spawn', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest();

    const routePromise = routeMessage(request);

    mockProc.emit('error', new Error('Docker not found'));

    await expect(routePromise).rejects.toThrow('spawn error');
  });

  /**
   * INVARIANT: direct_answer response is correctly parsed from IPC result file
   * SUT: routeMessage with direct_answer
   * VERIFICATION: Response includes directAnswer text
   */
  it('returns direct_answer with answer text from IPC result', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const routeDecision = {
      requestId: 'test-req-1',
      decision: 'direct_answer',
      confidence: 0.95,
      reason: 'Simple greeting',
      directAnswer: 'Hello! How can I help you today?',
    };

    mockFs.readFileSync.mockReturnValue(JSON.stringify(routeDecision));

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest({ messageText: 'Hello!' });

    const routePromise = routeMessage(request);

    // Container exits cleanly
    mockProc.emit('close', 0);

    const result = await routePromise;

    expect(result.decision).toBe('direct_answer');
    expect(result.directAnswer).toBe('Hello! How can I help you today?');
  });

  /**
   * INVARIANT: Container input includes ANTHROPIC_BASE_URL for credential proxy
   * SUT: routeMessage container environment
   * VERIFICATION: Spawn args include the proxy URL
   */
  it('sets ANTHROPIC_BASE_URL environment variable', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const routeDecision = {
      requestId: 'test-req-1',
      decision: 'suggest_new',
      confidence: 0.1,
      reason: 'test',
    };

    mockFs.readFileSync.mockReturnValue(JSON.stringify(routeDecision));

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest();

    const routePromise = routeMessage(request);

    mockProc.emit('close', 0);

    await routePromise;

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const envArgs = spawnArgs.join(' ');
    expect(envArgs).toContain(
      'ANTHROPIC_BASE_URL=http://host.docker.internal:3001',
    );
  });

  /**
   * INVARIANT: Container input is written to stdin as JSON
   * SUT: routeMessage stdin protocol
   * VERIFICATION: The container receives valid JSON via stdin
   */
  it('writes container input as JSON to stdin', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    let stdinData = '';
    mockProc.stdin.on('data', (chunk: Buffer) => {
      stdinData += chunk.toString();
    });

    const routeDecision = {
      requestId: 'test-req-1',
      decision: 'suggest_new',
      confidence: 0.3,
      reason: 'test',
    };

    mockFs.readFileSync.mockReturnValue(JSON.stringify(routeDecision));

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest();

    const routePromise = routeMessage(request);

    mockProc.emit('close', 0);

    await routePromise;

    // Parse what was written to stdin
    const parsed = JSON.parse(stdinData);
    expect(parsed.groupFolder).toBe('__router__');
    expect(parsed.chatJid).toBe('__router__');
    expect(parsed.isMain).toBe(false);
    expect(parsed.prompt).toContain('message router');
  });

  /**
   * INVARIANT: _close sentinel exists on disk when the container process is running.
   * SUT: runRouterContainer _close lifecycle
   * VERIFICATION: After container.stdin.end(), _close file has been written.
   *   This ensures the agent-runner's startup cleanup (which deletes stale sentinels)
   *   cannot race with the sentinel — the sentinel is written after the container starts.
   */
  it('_close sentinel exists after container starts (not deleted by startup cleanup)', async () => {
    const mockProc = createMockProcess();
    const writtenFiles: string[] = [];

    // Track which files are written after container spawn
    mockFs.writeFileSync.mockImplementation(
      (filePath: string, ..._args: unknown[]) => {
        writtenFiles.push(String(filePath));
      },
    );

    mockSpawn.mockReturnValue(mockProc);

    const routeDecision = {
      requestId: 'test-req-1',
      decision: 'suggest_new',
      confidence: 0.3,
      reason: 'test',
    };
    mockFs.readFileSync.mockReturnValue(JSON.stringify(routeDecision));

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest();
    const routePromise = routeMessage(request);
    mockProc.emit('close', 0);
    await routePromise;

    // _close sentinel must have been written (so the container can find and consume it)
    const closeWrites = writtenFiles.filter((f) => f.includes('_close'));
    expect(closeWrites.length).toBe(1);
  });

  /**
   * INVARIANT: On timeout, docker stop is called as fallback to kill the container.
   * SUT: runRouterContainer timeout handler
   * VERIFICATION: execSync is called with 'docker stop <containerName>' after timeout.
   */
  it('calls docker stop as fallback when container times out', async () => {
    vi.useFakeTimers();

    const { execSync: mockExecSync } = await import('child_process');

    const mockProc = createMockProcess();
    mockProc.kill = vi.fn();
    mockSpawn.mockReturnValue(mockProc);

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest();

    const routePromise = routeMessage(request).catch((err: Error) => err);

    // Advance past timeout (60s) + docker stop delay (8s)
    await vi.advanceTimersByTimeAsync(68_000);

    // docker stop should have been called
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('docker stop nanoclaw-router-'),
      expect.objectContaining({ stdio: 'pipe', timeout: 5000 }),
    );

    // Clean up — advance past force-reject
    await vi.advanceTimersByTimeAsync(2_000);
    await routePromise;

    vi.useRealTimers();
  });
});
