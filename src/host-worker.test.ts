import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChildProcess, EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

// Mock child_process.spawn before importing host-worker
const mockSpawn = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock fs to avoid real filesystem operations
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { runHostWorker, HostWorkerInput } from './host-worker.js';
import { RegisteredGroup } from './types.js';

function createMockProcess(): ChildProcess & {
  _stdout: EventEmitter;
  _stderr: EventEmitter;
  _stdin: Writable & { ended: boolean };
} {
  const proc = new EventEmitter() as any;
  proc._stdout = new EventEmitter();
  proc._stderr = new EventEmitter();
  proc.stdout = proc._stdout;
  proc.stderr = proc._stderr;
  proc._stdin = {
    ended: false,
    end: vi.fn(function (this: any) {
      this.ended = true;
    }),
    write: vi.fn(),
  } as any;
  proc.stdin = proc._stdin;
  proc.pid = 12345;
  proc.kill = vi.fn();
  return proc;
}

const TEST_GROUP: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Neo',
  added_at: '2024-01-01T00:00:00.000Z',
  containerConfig: { useHostWorker: true },
};

const TEST_INPUT: HostWorkerInput = {
  prompt: 'test prompt',
  groupFolder: 'test-group',
  chatJid: 'dc:123',
  isMain: true,
};

describe('Host Worker', () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('spawns claude with correct arguments', async () => {
    const promise = runHostWorker(TEST_GROUP, TEST_INPUT, vi.fn());

    // Simulate successful exit with no output
    mockProc.emit('close', 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe('claude');
    expect(args).toContain('-p');
    expect(args).toContain('test prompt');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--allowedTools');
    expect(opts.cwd).toBe('/root');
  });

  it('closes stdin immediately after spawn', async () => {
    const promise = runHostWorker(TEST_GROUP, TEST_INPUT, vi.fn());
    mockProc.emit('close', 0);
    await promise;

    expect(mockProc._stdin.end).toHaveBeenCalled();
  });

  it('passes --resume when sessionId is provided', async () => {
    const input: HostWorkerInput = {
      ...TEST_INPUT,
      sessionId: 'session-abc-123',
    };

    const promise = runHostWorker(TEST_GROUP, input, vi.fn());
    mockProc.emit('close', 0);
    await promise;

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--resume');
    expect(args).toContain('session-abc-123');
  });

  it('adds --add-dir for existing project directories', async () => {
    const promise = runHostWorker(TEST_GROUP, TEST_INPUT, vi.fn());
    mockProc.emit('close', 0);
    await promise;

    const args = mockSpawn.mock.calls[0][1] as string[];
    const addDirIndices = args.reduce<number[]>((acc, arg, i) => {
      if (arg === '--add-dir') acc.push(i);
      return acc;
    }, []);
    expect(addDirIndices.length).toBeGreaterThan(0);
  });

  it('uses custom cwd from containerConfig', async () => {
    const input: HostWorkerInput = {
      ...TEST_INPUT,
      cwd: '/home/custom',
    };

    const promise = runHostWorker(TEST_GROUP, input, vi.fn());
    mockProc.emit('close', 0);
    await promise;

    const opts = mockSpawn.mock.calls[0][2];
    expect(opts.cwd).toBe('/home/custom');
  });

  it('provides clean env without CLAUDECODE variables', async () => {
    const promise = runHostWorker(TEST_GROUP, TEST_INPUT, vi.fn());
    mockProc.emit('close', 0);
    await promise;

    const opts = mockSpawn.mock.calls[0][2];
    expect(opts.env.HOME).toBe('/root');
    expect(opts.env.PATH).toBeDefined();
    expect(opts.env.CLAUDECODE).toBeUndefined();
    expect(opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('calls onProcess callback with proc and worker name', async () => {
    const onProcess = vi.fn();
    const promise = runHostWorker(TEST_GROUP, TEST_INPUT, onProcess);
    mockProc.emit('close', 0);
    await promise;

    expect(onProcess).toHaveBeenCalledTimes(1);
    expect(onProcess.mock.calls[0][0]).toBe(mockProc);
    expect(onProcess.mock.calls[0][1]).toMatch(/^host-worker-test-group-/);
  });

  it('extracts session ID from system event', async () => {
    const onOutput = vi.fn().mockResolvedValue(undefined);
    const promise = runHostWorker(TEST_GROUP, TEST_INPUT, vi.fn(), onOutput);

    // Send system event with session_id
    mockProc._stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', session_id: 'new-session-123' }) + '\n',
    ));

    mockProc.emit('close', 0);
    const result = await promise;

    expect(result.newSessionId).toBe('new-session-123');
  });

  it('extracts result from result event', async () => {
    const onOutput = vi.fn().mockResolvedValue(undefined);
    const promise = runHostWorker(TEST_GROUP, TEST_INPUT, vi.fn(), onOutput);

    mockProc._stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'system', session_id: 'sess-1' }) + '\n' +
      JSON.stringify({ type: 'result', result: 'Hello from Claude', session_id: 'sess-1' }) + '\n',
    ));

    mockProc.emit('close', 0);
    const result = await promise;

    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('sess-1');
    // onOutput should have been called with the result
    expect(onOutput).toHaveBeenCalled();
    const resultCall = onOutput.mock.calls.find(
      (call: any[]) => call[0].result === 'Hello from Claude',
    );
    expect(resultCall).toBeDefined();
  });

  it('returns error on non-zero exit with no output', async () => {
    const promise = runHostWorker(TEST_GROUP, TEST_INPUT, vi.fn());

    mockProc._stderr.emit('data', Buffer.from('something went wrong\n'));
    mockProc.emit('close', 1);

    const result = await promise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('Host worker exited with code 1');
  });

  it('returns success on non-zero exit when output was already sent', async () => {
    const onOutput = vi.fn().mockResolvedValue(undefined);
    const promise = runHostWorker(TEST_GROUP, TEST_INPUT, vi.fn(), onOutput);

    // Send result first
    mockProc._stdout.emit('data', Buffer.from(
      JSON.stringify({ type: 'result', result: 'partial output' }) + '\n',
    ));

    // Then exit with error
    mockProc.emit('close', 1);

    const result = await promise;
    // Should still be success because we already got output
    expect(result.status).toBe('success');
  });

  it('handles spawn error gracefully', async () => {
    const promise = runHostWorker(TEST_GROUP, TEST_INPUT, vi.fn());

    mockProc.emit('error', new Error('ENOENT: claude not found'));

    const result = await promise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('spawn error');
  });

  it('handles partial JSON lines across data chunks', async () => {
    const onOutput = vi.fn().mockResolvedValue(undefined);
    const promise = runHostWorker(TEST_GROUP, TEST_INPUT, vi.fn(), onOutput);

    const jsonLine = JSON.stringify({ type: 'result', result: 'split output', session_id: 's1' });
    // Split in the middle
    const mid = Math.floor(jsonLine.length / 2);
    mockProc._stdout.emit('data', Buffer.from(jsonLine.slice(0, mid)));
    mockProc._stdout.emit('data', Buffer.from(jsonLine.slice(mid) + '\n'));

    mockProc.emit('close', 0);
    const result = await promise;

    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('s1');
  });
});
