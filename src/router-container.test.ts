import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts / router-container.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

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

// Mock fs
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

import { parseRouterResponse } from './router-container.js';
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

describe('parseRouterResponse', () => {
  /**
   * INVARIANT: Valid JSON router output is parsed into a RouterResponse
   * SUT: parseRouterResponse
   * VERIFICATION: All fields from the JSON are correctly extracted
   */
  it('parses a valid route_to_case response', () => {
    const json = JSON.stringify({
      requestId: 'req-1',
      decision: 'route_to_case',
      caseId: 'case-1',
      caseName: 'fix-auth',
      confidence: 0.9,
      reason: 'Message about auth',
    });

    const result = parseRouterResponse(json, 'req-1');

    expect(result.decision).toBe('route_to_case');
    expect(result.caseId).toBe('case-1');
    expect(result.caseName).toBe('fix-auth');
    expect(result.confidence).toBe(0.9);
    expect(result.reason).toBe('Message about auth');
  });

  /**
   * INVARIANT: Direct answer responses include the answer text
   * SUT: parseRouterResponse with direct_answer decision
   * VERIFICATION: directAnswer field is preserved
   */
  it('parses a direct_answer response with answer text', () => {
    const json = JSON.stringify({
      requestId: 'req-2',
      decision: 'direct_answer',
      confidence: 0.95,
      reason: 'Simple greeting',
      directAnswer: 'Hello! How can I help?',
    });

    const result = parseRouterResponse(json, 'req-2');

    expect(result.decision).toBe('direct_answer');
    expect(result.directAnswer).toBe('Hello! How can I help?');
    expect(result.caseId).toBeUndefined();
  });

  /**
   * INVARIANT: JSON embedded in surrounding text is still extracted
   * SUT: parseRouterResponse with text wrapping the JSON
   * VERIFICATION: Response is parsed even with surrounding text
   */
  it('extracts JSON from surrounding text', () => {
    const text = `Here is my routing decision:
{"requestId":"req-3","decision":"suggest_new","confidence":0.2,"reason":"No match"}
That's my answer.`;

    const result = parseRouterResponse(text, 'req-3');

    expect(result.decision).toBe('suggest_new');
    expect(result.confidence).toBe(0.2);
  });

  /**
   * INVARIANT: parseRouterResponse throws when no JSON is found
   * SUT: parseRouterResponse error handling
   * VERIFICATION: Error is thrown with descriptive message
   */
  it('throws when result contains no JSON', () => {
    expect(() => parseRouterResponse('No JSON here', 'req-4')).toThrow(
      'Router returned no JSON',
    );
  });

  /**
   * INVARIANT: Missing fields get safe defaults
   * SUT: parseRouterResponse default handling
   * VERIFICATION: Missing decision defaults to suggest_new, missing confidence to 0
   */
  it('provides safe defaults for missing fields', () => {
    const json = JSON.stringify({
      reason: 'partial response',
    });

    const result = parseRouterResponse(json, 'req-5');

    expect(result.requestId).toBe('req-5');
    expect(result.decision).toBe('suggest_new');
    expect(result.confidence).toBe(0);
    expect(result.reason).toBe('partial response');
  });

  /**
   * INVARIANT: Falls back to provided requestId when response omits it
   * SUT: parseRouterResponse requestId fallback
   * VERIFICATION: Provided requestId is used when not in the JSON
   */
  it('falls back to provided requestId when not in response', () => {
    const json = JSON.stringify({
      decision: 'suggest_new',
      confidence: 0.3,
      reason: 'test',
    });

    const result = parseRouterResponse(json, 'fallback-id');

    expect(result.requestId).toBe('fallback-id');
  });
});

describe('routeMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * INVARIANT: routeMessage spawns a container with minimal mounts (no group filesystem)
   * SUT: routeMessage container spawning
   * VERIFICATION: spawn is called with args that do NOT include group-specific mounts
   */
  it('spawns a container without group filesystem mounts', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    // Import dynamically to ensure mocks are in place
    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest();

    // Start the routing (non-blocking)
    const routePromise = routeMessage(request);

    // Simulate container output
    const output = {
      status: 'success',
      result: JSON.stringify({
        requestId: 'test-req-1',
        decision: 'route_to_case',
        caseId: 'case-1',
        caseName: 'fix-auth',
        confidence: 0.85,
        reason: 'Auth-related message',
      }),
    };

    mockProc.stdout.write(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
    );
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

    // Simulate timeout by not producing output — emit close with error
    // In reality the timeout handler kills the container, we simulate the close
    mockProc.emit('close', 137); // SIGKILL exit code

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
   * INVARIANT: direct_answer response is correctly parsed from container output
   * SUT: routeMessage with direct_answer
   * VERIFICATION: Response includes directAnswer text
   */
  it('returns direct_answer with answer text from container', async () => {
    const mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest({ messageText: 'Hello!' });

    const routePromise = routeMessage(request);

    const output = {
      status: 'success',
      result: JSON.stringify({
        requestId: request.requestId,
        decision: 'direct_answer',
        confidence: 0.95,
        reason: 'Simple greeting',
        directAnswer: 'Hello! How can I help you today?',
      }),
    };

    mockProc.stdout.write(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
    );
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

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest();

    const routePromise = routeMessage(request);

    const output = {
      status: 'success',
      result: JSON.stringify({
        requestId: 'test-req-1',
        decision: 'suggest_new',
        confidence: 0.1,
        reason: 'test',
      }),
    };

    mockProc.stdout.write(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
    );
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

    const { routeMessage } = await import('./router-container.js');
    const request = makeRouterRequest();

    const routePromise = routeMessage(request);

    const output = {
      status: 'success',
      result: JSON.stringify({
        requestId: 'test-req-1',
        decision: 'suggest_new',
        confidence: 0.3,
        reason: 'test',
      }),
    };

    mockProc.stdout.write(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
    );
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
