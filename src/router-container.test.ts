import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
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
   * INVARIANT: readRouterResult throws when no result file exists
   * SUT: readRouterResult error path
   * VERIFICATION: Error is thrown with descriptive message
   */
  it('throws when result file does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);

    expect(() => readRouterResult('req-missing')).toThrow('no result file');
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
});
