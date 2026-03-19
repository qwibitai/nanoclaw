import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match dev-session.ts and agent-runner
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_NAME_PREFIX: 'nanoclaw-',
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  TIMEZONE: 'America/Los_Angeles',
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
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      cpSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

// Mock group-folder
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/nanoclaw-test-groups/${folder}`,
  ),
  resolveGroupIpcPath: vi.fn(
    (folder: string) => `/tmp/nanoclaw-test-data/ipc/${folder}`,
  ),
}));

// Mock schemas
vi.mock('./schemas.js', () => ({
  ContainerOutputSchema: {
    parse: vi.fn((obj: unknown) => obj),
  },
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: vi.fn(() => [
    '--add-host=host.docker.internal:host-gateway',
  ]),
  readonlyMountArgs: vi.fn((host: string, container: string) => [
    '-v',
    `${host}:${container}:ro`,
  ]),
  stopContainer: vi.fn((name: string) => `docker stop ${name}`),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => {
      fakeProc = createFakeProcess();
      return fakeProc;
    }),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return createFakeProcess();
      },
    ),
  };
});

import type { Case } from './cases.js';
import type { RegisteredGroup } from './types.js';
import type { DevSessionConfig } from './dev-session.js';

function makeTestCase(overrides: Partial<Case> = {}): Case {
  const now = new Date().toISOString();
  return {
    id: `case-test-${Date.now()}`,
    group_folder: 'main',
    chat_jid: 'tg:123',
    name: '260319-1000-k134-test',
    description: 'Test dev case',
    type: 'dev',
    status: 'active',
    blocked_on: null,
    worktree_path: null,
    workspace_path: '/tmp/test',
    branch_name: null,
    initiator: 'test',
    initiator_channel: null,
    last_message: null,
    last_activity_at: now,
    conclusion: null,
    created_at: now,
    done_at: null,
    reviewed_at: null,
    pruned_at: null,
    total_cost_usd: 0,
    token_source: null,
    time_spent_ms: 0,
    github_issue: 134,
    github_issue_url: null,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    customer_org: null,
    priority: null,
    gap_type: null,
    ...overrides,
  };
}

function makeTestGroup(
  overrides: Partial<RegisteredGroup> = {},
): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'main',
    trigger: 'test',
    added_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeTestConfig(
  overrides: Partial<DevSessionConfig> = {},
): DevSessionConfig {
  return {
    case: makeTestCase(),
    group: makeTestGroup(),
    isMain: true,
    notifyChatJid: 'tg:123',
    botName: 'DevAda',
    initialPrompt: 'Implement kaizen #134',
    ...overrides,
  };
}

// INVARIANT: Dev session container args include all required environment variables
// for case context, credentials, and dev mode.
// SUT: buildDevSessionContainerArgs
// VERIFICATION: Check that args array contains expected -e flags.
describe('buildDevSessionContainerArgs', () => {
  let buildDevSessionContainerArgs: typeof import('./dev-session.js').buildDevSessionContainerArgs;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./dev-session.js');
    buildDevSessionContainerArgs = mod.buildDevSessionContainerArgs;
  });

  it('includes case context env vars', () => {
    const config = makeTestConfig();
    const { args } = buildDevSessionContainerArgs(config, 'test-container');

    expect(args).toContain(`NANOCLAW_CASE_ID=${config.case.id}`);
    expect(args).toContain(`NANOCLAW_CASE_NAME=${config.case.name}`);
    expect(args).toContain('NANOCLAW_CASE_TYPE=dev');
    expect(args).toContain('NANOCLAW_DEV_MODE=1');
    expect(args).toContain('NANOCLAW_BOT_NAME=DevAda');
    expect(args).toContain('NANOCLAW_SESSION_MODE=dev');
  });

  it('includes GITHUB_TOKEN when available', () => {
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_test123';
    try {
      const config = makeTestConfig();
      const { args } = buildDevSessionContainerArgs(config, 'test-container');

      // Find the env args that contain GITHUB_TOKEN
      const hasGithubToken = args.some((a) => a === 'GITHUB_TOKEN=ghp_test123');
      const hasGhToken = args.some((a) => a === 'GH_TOKEN=ghp_test123');
      expect(hasGithubToken).toBe(true);
      expect(hasGhToken).toBe(true);
    } finally {
      if (originalToken) {
        process.env.GITHUB_TOKEN = originalToken;
      } else {
        delete process.env.GITHUB_TOKEN;
      }
    }
  });

  it('mounts project root read-only', () => {
    const config = makeTestConfig();
    const { args } = buildDevSessionContainerArgs(config, 'test-container');

    // readonlyMountArgs is mocked to return ['-v', 'host:container:ro']
    const projectRoMount = args.some((a) =>
      a.includes('/workspace/project:ro'),
    );
    expect(projectRoMount).toBe(true);
  });

  it('does NOT mount case workspace read-write', () => {
    const config = makeTestConfig({
      case: makeTestCase({ workspace_path: '/some/worktree' }),
    });
    const { args } = buildDevSessionContainerArgs(config, 'test-container');

    // Dev sessions should NOT have /workspace/case mount (clone inside instead)
    const hasCaseMount = args.some((a) => a.includes('/workspace/case'));
    expect(hasCaseMount).toBe(false);
  });

  it('uses container name with dev prefix', () => {
    const config = makeTestConfig();
    const { args } = buildDevSessionContainerArgs(
      config,
      'nanoclaw-dev-main-123',
    );

    expect(args).toContain('nanoclaw-dev-main-123');
  });

  it('returns the IPC directory path', () => {
    const config = makeTestConfig();
    const { ipcDir } = buildDevSessionContainerArgs(config, 'test-container');

    expect(ipcDir).toBe('/tmp/nanoclaw-test-data/ipc/main');
  });

  it('overrides entrypoint to dev-entrypoint.sh', () => {
    const config = makeTestConfig();
    const { args } = buildDevSessionContainerArgs(config, 'test-container');

    const entrypointIdx = args.indexOf('--entrypoint');
    expect(entrypointIdx).toBeGreaterThan(-1);
    expect(args[entrypointIdx + 1]).toBe('/app/dev-entrypoint.sh');
  });
});

// INVARIANT: Dev session input includes all fields needed by the agent-runner.
// SUT: buildDevSessionInput
// VERIFICATION: Parsed JSON has all expected fields.
describe('buildDevSessionInput', () => {
  let buildDevSessionInput: typeof import('./dev-session.js').buildDevSessionInput;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./dev-session.js');
    buildDevSessionInput = mod.buildDevSessionInput;
  });

  it('produces valid JSON with all required fields', () => {
    const config = makeTestConfig();
    const json = buildDevSessionInput(config);
    const parsed = JSON.parse(json);

    expect(parsed.prompt).toBe('Implement kaizen #134');
    expect(parsed.groupFolder).toBe('main');
    expect(parsed.chatJid).toBe('tg:123');
    expect(parsed.isMain).toBe(true);
    expect(parsed.assistantName).toBe('DevAda');
    expect(parsed.caseId).toBe(config.case.id);
    expect(parsed.caseName).toBe(config.case.name);
    expect(parsed.caseType).toBe('dev');
    expect(parsed.devModeRequested).toBe(true);
  });
});

// INVARIANT: Only one dev session can be active per case at a time.
// SUT: startDevSession, getActiveDevSession
// VERIFICATION: Second start attempt throws; first session is retrievable.
describe('session lifecycle', () => {
  let startDevSession: typeof import('./dev-session.js').startDevSession;
  let getActiveDevSession: typeof import('./dev-session.js').getActiveDevSession;
  let getAllActiveDevSessions: typeof import('./dev-session.js').getAllActiveDevSessions;
  let getDevSessionByBotName: typeof import('./dev-session.js').getDevSessionByBotName;
  let stopDevSession: typeof import('./dev-session.js').stopDevSession;
  let sendMessageToDevSession: typeof import('./dev-session.js').sendMessageToDevSession;
  let _clearActiveSessions: typeof import('./dev-session.js')._clearActiveSessions;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const mod = await import('./dev-session.js');
    startDevSession = mod.startDevSession;
    getActiveDevSession = mod.getActiveDevSession;
    getAllActiveDevSessions = mod.getAllActiveDevSessions;
    getDevSessionByBotName = mod.getDevSessionByBotName;
    stopDevSession = mod.stopDevSession;
    sendMessageToDevSession = mod.sendMessageToDevSession;
    _clearActiveSessions = mod._clearActiveSessions;
  });

  afterEach(() => {
    _clearActiveSessions();
    vi.useRealTimers();
  });

  it('starts a session and makes it retrievable by case ID', async () => {
    const config = makeTestConfig();
    const session = await startDevSession(config);

    expect(session.caseId).toBe(config.case.id);
    expect(session.botName).toBe('DevAda');
    expect(session.ended).toBe(false);

    const retrieved = getActiveDevSession(config.case.id);
    expect(retrieved).toBe(session);
  });

  it('prevents duplicate sessions for the same case', async () => {
    const config = makeTestConfig();
    await startDevSession(config);

    await expect(startDevSession(config)).rejects.toThrow(
      /Dev session already active/,
    );
  });

  it('is findable by bot name', async () => {
    const config = makeTestConfig({ botName: 'DevBob' });
    const session = await startDevSession(config);

    const found = getDevSessionByBotName('DevBob');
    expect(found).toBe(session);

    const notFound = getDevSessionByBotName('DevCarol');
    expect(notFound).toBeUndefined();
  });

  it('lists all active sessions', async () => {
    const config1 = makeTestConfig({
      case: makeTestCase({ id: 'case-1' }),
      botName: 'DevAda',
    });
    const config2 = makeTestConfig({
      case: makeTestCase({ id: 'case-2' }),
      botName: 'DevBob',
    });

    await startDevSession(config1);
    await startDevSession(config2);

    expect(getAllActiveDevSessions()).toHaveLength(2);
  });

  it('cleans up session on container exit', async () => {
    const onEnd = vi.fn();
    const config = makeTestConfig();
    await startDevSession(config, undefined, onEnd);

    // Simulate container exit
    fakeProc.emit('close', 0);

    expect(getActiveDevSession(config.case.id)).toBeUndefined();
    expect(onEnd).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: config.case.id }),
      'completed',
    );
  });

  it('cleans up session on container error exit', async () => {
    const onEnd = vi.fn();
    const config = makeTestConfig();
    await startDevSession(config, undefined, onEnd);

    fakeProc.emit('close', 1);

    expect(onEnd).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: config.case.id }),
      'exit-code-1',
    );
  });

  it('stopDevSession writes _close sentinel', async () => {
    const fs = await import('fs');
    const config = makeTestConfig();
    await startDevSession(config);

    stopDevSession(config.case.id, 'manual');

    expect(fs.default.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('_close'),
      '',
    );
  });

  it('sends IPC message to running session', async () => {
    const fs = await import('fs');
    const config = makeTestConfig();
    const session = await startDevSession(config);

    const sent = sendMessageToDevSession(session, 'How is it going?');

    expect(sent).toBe(true);
    expect(fs.default.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('input/msg-'),
      expect.stringContaining('How is it going?'),
    );
  });

  it('refuses to send message to ended session', async () => {
    const config = makeTestConfig();
    const session = await startDevSession(config);
    fakeProc.emit('close', 0);

    const sent = sendMessageToDevSession(session, 'Hello?');
    expect(sent).toBe(false);
  });
});

// INVARIANT: Output markers from the container are parsed and forwarded to the callback.
// SUT: startDevSession output parsing
// VERIFICATION: onOutput callback receives parsed ContainerOutput.
describe('output parsing', () => {
  let startDevSession: typeof import('./dev-session.js').startDevSession;
  let _clearActiveSessions: typeof import('./dev-session.js')._clearActiveSessions;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const mod = await import('./dev-session.js');
    startDevSession = mod.startDevSession;
    _clearActiveSessions = mod._clearActiveSessions;
  });

  afterEach(() => {
    _clearActiveSessions();
    vi.useRealTimers();
  });

  it('parses output markers and calls onOutput', async () => {
    const outputs: unknown[] = [];
    const onOutput = vi.fn(async (output) => {
      outputs.push(output);
    });

    const config = makeTestConfig();
    await startDevSession(config, onOutput);

    // Simulate container output
    const output = {
      status: 'success',
      result: 'PR created',
      newSessionId: 'session-123',
    };
    fakeProc.stdout.write(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
    );

    // Allow microtask to process
    await vi.advanceTimersByTimeAsync(0);

    expect(onOutput).toHaveBeenCalledWith(output);
  });

  it('updates sdkSessionId from output', async () => {
    const config = makeTestConfig();
    const session = await startDevSession(config, async () => {});

    const output = {
      status: 'success',
      result: null,
      newSessionId: 'session-456',
    };
    fakeProc.stdout.write(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(session.sdkSessionId).toBe('session-456');
  });

  it('handles output markers split across multiple chunks', async () => {
    const onOutput = vi.fn(async () => {});
    const config = makeTestConfig();
    await startDevSession(config, onOutput);

    const output = { status: 'success', result: 'split test' };
    const full = `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`;

    // Split the output across 3 chunks
    const mid = Math.floor(full.length / 2);
    fakeProc.stdout.write(full.slice(0, mid));
    await vi.advanceTimersByTimeAsync(0);
    expect(onOutput).not.toHaveBeenCalled();

    fakeProc.stdout.write(full.slice(mid));
    await vi.advanceTimersByTimeAsync(0);
    expect(onOutput).toHaveBeenCalledWith(output);
  });

  it('handles multiple output markers in rapid succession', async () => {
    const outputs: unknown[] = [];
    const onOutput = vi.fn(async (o) => {
      outputs.push(o);
    });

    const config = makeTestConfig();
    await startDevSession(config, onOutput);

    const output1 = { status: 'success', result: 'first' };
    const output2 = { status: 'success', result: 'second' };

    fakeProc.stdout.write(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output1)}\n${OUTPUT_END_MARKER}\n` +
        `${OUTPUT_START_MARKER}\n${JSON.stringify(output2)}\n${OUTPUT_END_MARKER}\n`,
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(outputs[0]).toEqual(output1);
    expect(outputs[1]).toEqual(output2);
  });
});

// INVARIANT: Session timeout (30 min) and idle timeout (5 min) enforce
// resource limits and prevent runaway containers.
// SUT: startDevSession timeout behavior
// VERIFICATION: Session is cleaned up when timeouts fire.
describe('timeout enforcement', () => {
  let startDevSession: typeof import('./dev-session.js').startDevSession;
  let getActiveDevSession: typeof import('./dev-session.js').getActiveDevSession;
  let _clearActiveSessions: typeof import('./dev-session.js')._clearActiveSessions;
  let DEV_SESSION_TIMEOUT_MS: number;
  let DEV_SESSION_IDLE_TIMEOUT_MS: number;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const mod = await import('./dev-session.js');
    startDevSession = mod.startDevSession;
    getActiveDevSession = mod.getActiveDevSession;
    _clearActiveSessions = mod._clearActiveSessions;
    DEV_SESSION_TIMEOUT_MS = mod.DEV_SESSION_TIMEOUT_MS;
    DEV_SESSION_IDLE_TIMEOUT_MS = mod.DEV_SESSION_IDLE_TIMEOUT_MS;
  });

  afterEach(() => {
    _clearActiveSessions();
    vi.useRealTimers();
  });

  it('terminates session after 30 min session timeout', async () => {
    const onEnd = vi.fn();
    const config = makeTestConfig();
    await startDevSession(config, undefined, onEnd);

    expect(getActiveDevSession(config.case.id)).toBeDefined();

    // Advance past session timeout
    await vi.advanceTimersByTimeAsync(DEV_SESSION_TIMEOUT_MS + 1000);

    // Session should be cleaned up after container exits
    // (endDevSession writes _close, then setTimeout 5s for force-stop)
    expect(onEnd).not.toHaveBeenCalled(); // container hasn't exited yet
    // But the session is marked as ended
    const session = getActiveDevSession(config.case.id);
    // Session may still be in map but marked ended, or removed after container close
    // The key invariant: endDevSession was called (wrote _close sentinel)
    const fs = await import('fs');
    expect(fs.default.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('_close'),
      '',
    );
  });

  it('terminates session after 5 min idle timeout', async () => {
    const config = makeTestConfig();
    await startDevSession(config);

    const fs = await import('fs');
    const writeCallsBefore = (
      fs.default.writeFileSync as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    // Advance past idle timeout
    await vi.advanceTimersByTimeAsync(DEV_SESSION_IDLE_TIMEOUT_MS + 1000);

    // Should have written _close sentinel
    const writeCalls = (fs.default.writeFileSync as ReturnType<typeof vi.fn>)
      .mock.calls;
    const closeWrites = writeCalls
      .slice(writeCallsBefore)
      .filter(
        (call: unknown[]) =>
          typeof call[0] === 'string' && (call[0] as string).includes('_close'),
      );
    expect(closeWrites.length).toBeGreaterThan(0);
  });

  it('resets idle timeout when output is received', async () => {
    const config = makeTestConfig();
    await startDevSession(config, async () => {});

    // Advance 4 minutes (just under 5 min idle timeout)
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

    // Emit output — should reset idle timer
    const output = { status: 'success', result: 'still working' };
    fakeProc.stdout.write(
      `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
    );
    await vi.advanceTimersByTimeAsync(0);

    // Advance another 4 minutes (total 8 min, but only 4 since last output)
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

    // Session should still be active (idle timer was reset)
    expect(getActiveDevSession(config.case.id)).toBeDefined();

    // Now advance past idle timeout from last output
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    // Now the _close sentinel should have been written
    const fs = await import('fs');
    expect(fs.default.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('_close'),
      '',
    );
  });
});

// INVARIANT: getDevSessionByContainerName returns the session matching
// the given container name.
// SUT: getDevSessionByContainerName
// VERIFICATION: Returns correct session or undefined.
describe('getDevSessionByContainerName', () => {
  let startDevSession: typeof import('./dev-session.js').startDevSession;
  let getDevSessionByContainerName: typeof import('./dev-session.js').getDevSessionByContainerName;
  let _clearActiveSessions: typeof import('./dev-session.js')._clearActiveSessions;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const mod = await import('./dev-session.js');
    startDevSession = mod.startDevSession;
    getDevSessionByContainerName = mod.getDevSessionByContainerName;
    _clearActiveSessions = mod._clearActiveSessions;
  });

  afterEach(() => {
    _clearActiveSessions();
    vi.useRealTimers();
  });

  it('finds session by container name', async () => {
    const config = makeTestConfig();
    const session = await startDevSession(config);

    const found = getDevSessionByContainerName(session.containerName);
    expect(found).toBe(session);
  });

  it('returns undefined for unknown container name', async () => {
    const found = getDevSessionByContainerName('nonexistent-container');
    expect(found).toBeUndefined();
  });
});
