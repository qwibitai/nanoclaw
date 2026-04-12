import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match agent-spawn-markers.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

/* ------------------------------------------------------------------ */
/*  Hoisted mock references (accessible inside vi.mock factories)      */
/* ------------------------------------------------------------------ */

const { mockLogger, mockWriteFileSync } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mockWriteFileSync: vi.fn(),
}));

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

vi.mock('../core/config.js', () => ({
  AGENT_MAX_OUTPUT_SIZE: 512, // small limit so truncation tests are manageable
  AGENT_TIMEOUT: 5000, // 5 s
  IDLE_TIMEOUT: 5000, // 5 s
}));

vi.mock('../core/logger.js', () => ({
  logger: mockLogger,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
    },
  };
});

vi.mock('./agent-spawn-markers.js', () => ({
  OUTPUT_START_MARKER: '---NANOCLAW_OUTPUT_START---',
  OUTPUT_END_MARKER: '---NANOCLAW_OUTPUT_END---',
}));

/* ------------------------------------------------------------------ */
/*  Fake child process helper                                          */
/* ------------------------------------------------------------------ */

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
  proc.pid = 99999;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
  };
});

/* ------------------------------------------------------------------ */
/*  Import under test (after all mocks are registered)                 */
/* ------------------------------------------------------------------ */

import { executeRunnerProcess } from './agent-spawn-process.js';
import type { RunnerProcessSpec } from './agent-spawn-types.js';
import type { RegisteredGroup } from '../core/types.js';

/* ------------------------------------------------------------------ */
/*  Shared fixtures                                                    */
/* ------------------------------------------------------------------ */

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@bot',
  added_at: new Date().toISOString(),
};

function makeSpec(
  overrides: Partial<RunnerProcessSpec> = {},
): RunnerProcessSpec {
  return {
    group: testGroup,
    input: {
      prompt: 'Hello there',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
    },
    command: '/usr/bin/node',
    args: ['runner.js'],
    env: { PATH: '/usr/bin' },
    onProcess: vi.fn(),
    onOutput: undefined,
    options: undefined,
    runnerLabel: 'test-runner',
    processName: 'test-proc',
    startTime: Date.now(),
    logsDir: '/tmp/test-logs',
    runtimeDetails: ['detail-1', 'detail-2'],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('executeRunnerProcess', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    mockLogger.debug.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    mockWriteFileSync.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /* ============================================================== */
  /*  Non-zero exit code (lines 268-286)                             */
  /* ============================================================== */

  describe('non-zero exit code error path', () => {
    it('resolves with error when process exits with non-zero code', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      // Emit some stderr before exit
      fakeProc.stderr.push('something went wrong\n');
      fakeProc.emit('close', 1);

      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.result).toBeNull();
      expect(result.error).toContain('exited with code 1');
      expect(result.error).toContain('something went wrong');
    });

    it('truncates stderr in error message to last 200 chars', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      const longStderr = 'x'.repeat(500);
      fakeProc.stderr.push(longStderr);
      fakeProc.emit('close', 2);

      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      // The error field should contain at most 200 chars of stderr
      expect(result.error).toContain('x'.repeat(200));
    });

    it('writes a log file on non-zero exit code', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      fakeProc.stderr.push('fail\n');
      fakeProc.emit('close', 1);

      await vi.advanceTimersByTimeAsync(10);
      await resultP;

      expect(mockWriteFileSync).toHaveBeenCalled();
      const [logPath, logContent] = mockWriteFileSync.mock.calls[0];
      expect(logPath).toMatch(/\/tmp\/test-logs\/agent-.*\.log/);
      expect(logContent).toContain('=== Agent Run Log ===');
      expect(logContent).toContain('Exit Code: 1');
      // Non-zero exit triggers verbose-like output with stderr/stdout sections
      expect(logContent).toContain('=== Stderr ===');
      expect(logContent).toContain('=== Stdout ===');
    });

    it('logs error with group details on non-zero exit', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      fakeProc.emit('close', 127);

      await vi.advanceTimersByTimeAsync(10);
      await resultP;

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'Test Group',
          code: 127,
        }),
        expect.stringContaining('exited with error'),
      );
    });
  });

  /* ============================================================== */
  /*  Spawn error (lines 337-348)                                    */
  /* ============================================================== */

  describe('spawn error handler', () => {
    it('resolves with error when spawn emits error event', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      fakeProc.emit('error', new Error('ENOENT: command not found'));

      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.result).toBeNull();
      expect(result.error).toContain('spawn error');
      expect(result.error).toContain('ENOENT: command not found');
    });

    it('clears timeout on spawn error', async () => {
      const spec = makeSpec({ options: { timeoutMs: 100 } });
      const resultP = executeRunnerProcess(spec);

      fakeProc.emit('error', new Error('EACCES'));

      await vi.advanceTimersByTimeAsync(10);
      const result = await resultP;
      expect(result.status).toBe('error');

      // Advance past what would have been the timeout — should not
      // trigger a second resolve or kill.
      await vi.advanceTimersByTimeAsync(200);
      expect(fakeProc.kill).not.toHaveBeenCalled();
    });

    it('logs spawn error with group and process details', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      const err = new Error('permission denied');
      fakeProc.emit('error', err);

      await vi.advanceTimersByTimeAsync(10);
      await resultP;

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'Test Group',
          processName: 'test-proc',
          error: err,
        }),
        expect.stringContaining('spawn error'),
      );
    });
  });

  /* ============================================================== */
  /*  Timeout paths                                                  */
  /* ============================================================== */

  describe('timeout handling', () => {
    it('kills process after configured timeoutMs', async () => {
      const spec = makeSpec({ options: { timeoutMs: 200 } });
      const resultP = executeRunnerProcess(spec);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(250);

      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

      // Simulate OS reporting the killed process
      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out after 200ms');
    });

    it('writes timeout log on timeout with no output', async () => {
      const spec = makeSpec({ options: { timeoutMs: 100 } });
      const resultP = executeRunnerProcess(spec);

      await vi.advanceTimersByTimeAsync(150);
      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      expect(mockWriteFileSync).toHaveBeenCalled();
      const [, logContent] = mockWriteFileSync.mock.calls[0];
      expect(logContent).toContain('TIMEOUT');
      expect(logContent).toContain('Had Streaming Output: false');
    });

    it('timeout after streaming output resolves as success', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput, options: { timeoutMs: 200 } });
      const resultP = executeRunnerProcess(spec);

      // Emit streaming output
      const json = JSON.stringify({
        status: 'success',
        result: 'streamed result',
        newSessionId: 'sess-1',
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
      );

      await vi.advanceTimersByTimeAsync(10);

      // Now advance past timeout
      await vi.advanceTimersByTimeAsync(250);

      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('success');
      expect(result.newSessionId).toBe('sess-1');
      expect(onOutput).toHaveBeenCalled();
    });

    it('resets timeout on each streaming output chunk', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput, options: { timeoutMs: 300 } });
      const resultP = executeRunnerProcess(spec);

      // Emit first chunk at t=0
      const json1 = JSON.stringify({ status: 'success', result: 'chunk1' });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json1}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      // Advance 250ms (< 300ms timeout), then emit second chunk
      await vi.advanceTimersByTimeAsync(250);
      const json2 = JSON.stringify({
        status: 'success',
        result: 'chunk2',
        newSessionId: 'sess-2',
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json2}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      // Advance another 250ms — within the *reset* timeout window
      await vi.advanceTimersByTimeAsync(250);

      // Process should NOT have been killed yet (only 250ms since last chunk)
      expect(fakeProc.kill).not.toHaveBeenCalled();

      // Normal exit
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('success');
      expect(result.newSessionId).toBe('sess-2');
      expect(onOutput).toHaveBeenCalledTimes(2);
    });

    it('uses group agentConfig.timeout when options.timeoutMs not set', async () => {
      const groupWithTimeout: RegisteredGroup = {
        ...testGroup,
        agentConfig: { timeout: 150 },
      };
      const spec = makeSpec({
        group: groupWithTimeout,
        options: undefined,
      });
      const resultP = executeRunnerProcess(spec);

      // The timeout should be max(150, IDLE_TIMEOUT + 30000) = max(150, 35000) = 35000
      // because options.timeoutMs is not set, Math.max applies
      // IDLE_TIMEOUT is 5000, so 5000 + 30000 = 35000
      await vi.advanceTimersByTimeAsync(35100);

      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out');
    });
  });

  /* ============================================================== */
  /*  Stdout / stderr truncation                                     */
  /* ============================================================== */

  describe('output truncation', () => {
    it('truncates stdout when exceeding AGENT_MAX_OUTPUT_SIZE', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      // AGENT_MAX_OUTPUT_SIZE is mocked to 512
      const bigChunk = 'A'.repeat(600);
      fakeProc.stdout.push(bigChunk);

      await vi.advanceTimersByTimeAsync(10);

      // Emit valid output so it can parse
      const output = JSON.stringify({ status: 'success', result: 'ok' });
      // stdout is already truncated at 512, so legacy parse will fail
      // — we still expect a resolution
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      // Stdout was truncated so JSON parse fails — expect error
      expect(result.status).toBe('error');
      expect(result.error).toContain('Failed to parse runner output');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ group: 'Test Group' }),
        expect.stringContaining('stdout truncated'),
      );
    });

    it('truncates stderr when exceeding AGENT_MAX_OUTPUT_SIZE', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      const bigStderr = 'E'.repeat(600);
      fakeProc.stderr.push(bigStderr);

      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 1);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ group: 'Test Group' }),
        expect.stringContaining('stderr truncated'),
      );
    });
  });

  /* ============================================================== */
  /*  Legacy output parsing (no onOutput)                            */
  /* ============================================================== */

  describe('legacy output parsing (no onOutput)', () => {
    it('parses JSON from the last line of stdout', async () => {
      const spec = makeSpec({ onOutput: undefined });
      const resultP = executeRunnerProcess(spec);

      const output = JSON.stringify({
        status: 'success',
        result: 'legacy result',
      });
      fakeProc.stdout.push(`some debug line\nanother line\n${output}\n`);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('success');
      expect(result.result).toBe('legacy result');
    });

    it('parses JSON from marker-delimited output', async () => {
      const spec = makeSpec({ onOutput: undefined });
      const resultP = executeRunnerProcess(spec);

      const output = JSON.stringify({
        status: 'success',
        result: 'marked result',
        newSessionId: 'sess-xyz',
      });
      fakeProc.stdout.push(
        `debug line\n${OUTPUT_START_MARKER}\n${output}\n${OUTPUT_END_MARKER}\ntrailing\n`,
      );

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('success');
      expect(result.result).toBe('marked result');
      expect(result.newSessionId).toBe('sess-xyz');
    });

    it('resolves with error when stdout is not valid JSON', async () => {
      const spec = makeSpec({ onOutput: undefined });
      const resultP = executeRunnerProcess(spec);

      fakeProc.stdout.push('this is not json\n');
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.result).toBeNull();
      expect(result.error).toContain('Failed to parse runner output');
    });

    it('logs parse error with stdout and stderr context', async () => {
      const spec = makeSpec({ onOutput: undefined });
      const resultP = executeRunnerProcess(spec);

      fakeProc.stdout.push('garbage\n');
      fakeProc.stderr.push('some stderr\n');
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          group: 'Test Group',
          stdout: expect.stringContaining('garbage'),
          stderr: expect.stringContaining('some stderr'),
        }),
        'Failed to parse runner output',
      );
    });
  });

  /* ============================================================== */
  /*  Streaming output with onOutput                                 */
  /* ============================================================== */

  describe('streaming output mode (with onOutput)', () => {
    it('resolves with success and null result on normal exit', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);

      const json = JSON.stringify({
        status: 'success',
        result: 'streamed',
        newSessionId: 'sess-abc',
      });
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('success');
      expect(result.result).toBeNull();
      expect(result.newSessionId).toBe('sess-abc');
    });

    it('warns but continues on malformed streaming JSON', async () => {
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);

      // Push a malformed chunk
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n{not json}\n${OUTPUT_END_MARKER}\n`,
      );
      await vi.advanceTimersByTimeAsync(10);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ group: 'Test Group' }),
        'Failed to parse streamed output chunk',
      );
      expect(onOutput).not.toHaveBeenCalled();

      // Process can still exit normally
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      // No streaming output was successfully parsed, and onOutput is set,
      // so it goes through the streaming path
      expect(result.status).toBe('success');
      expect(result.result).toBeNull();
    });

    it('handles multiple streaming output chunks', async () => {
      const outputs: Array<{ status: string; result: string | null }> = [];
      const onOutput = vi.fn(async (parsed) => {
        outputs.push(parsed);
      });
      const spec = makeSpec({ onOutput });
      const resultP = executeRunnerProcess(spec);

      for (let i = 0; i < 3; i++) {
        const json = JSON.stringify({
          status: 'success',
          result: `chunk-${i}`,
        });
        fakeProc.stdout.push(
          `${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`,
        );
      }
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      expect(onOutput).toHaveBeenCalledTimes(3);
      expect(outputs.map((o) => o.result)).toEqual([
        'chunk-0',
        'chunk-1',
        'chunk-2',
      ]);
    });
  });

  /* ============================================================== */
  /*  Log file content checks                                        */
  /* ============================================================== */

  describe('log file writing', () => {
    it('writes verbose log when LOG_LEVEL=debug', async () => {
      const origLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = 'debug';

      try {
        const spec = makeSpec({
          input: {
            prompt: 'test prompt',
            groupFolder: 'test-group',
            chatJid: 'test@g.us',
            isMain: false,
            sessionId: 'sess-existing',
          },
        });
        const resultP = executeRunnerProcess(spec);

        const output = JSON.stringify({ status: 'success', result: 'ok' });
        fakeProc.stdout.push(output + '\n');
        fakeProc.emit('close', 0);
        await vi.advanceTimersByTimeAsync(10);

        await resultP;

        expect(mockWriteFileSync).toHaveBeenCalled();
        const [, logContent] = mockWriteFileSync.mock.calls[0];
        expect(logContent).toContain('=== Input ===');
        expect(logContent).toContain('=== Spawn Command ===');
        expect(logContent).toContain('/usr/bin/node runner.js');
        expect(logContent).toContain('=== Runtime Details ===');
        expect(logContent).toContain('detail-1');
      } finally {
        if (origLogLevel === undefined) {
          delete process.env.LOG_LEVEL;
        } else {
          process.env.LOG_LEVEL = origLogLevel;
        }
      }
    });

    it('writes summary log (not verbose) on normal success', async () => {
      const origLogLevel = process.env.LOG_LEVEL;
      delete process.env.LOG_LEVEL;

      try {
        const spec = makeSpec();
        const resultP = executeRunnerProcess(spec);

        const output = JSON.stringify({ status: 'success', result: 'done' });
        fakeProc.stdout.push(output + '\n');
        fakeProc.emit('close', 0);
        await vi.advanceTimersByTimeAsync(10);

        await resultP;

        expect(mockWriteFileSync).toHaveBeenCalled();
        const [, logContent] = mockWriteFileSync.mock.calls[0];
        expect(logContent).toContain('=== Input Summary ===');
        expect(logContent).toContain('Prompt length:');
        // Should NOT contain full input dump
        expect(logContent).not.toContain('=== Input ===');
        // Should NOT contain stdout/stderr sections on successful non-verbose
        expect(logContent).not.toContain('=== Stdout ===');
      } finally {
        if (origLogLevel === undefined) {
          delete process.env.LOG_LEVEL;
        } else {
          process.env.LOG_LEVEL = origLogLevel;
        }
      }
    });

    it('writes truncation markers in log when output was truncated', async () => {
      const origLogLevel = process.env.LOG_LEVEL;
      process.env.LOG_LEVEL = 'debug';

      try {
        const spec = makeSpec();
        const resultP = executeRunnerProcess(spec);

        // Exceed AGENT_MAX_OUTPUT_SIZE (512)
        fakeProc.stdout.push('X'.repeat(600));
        fakeProc.stderr.push('Y'.repeat(600));
        await vi.advanceTimersByTimeAsync(10);

        fakeProc.emit('close', 1); // non-zero to trigger verbose logging
        await vi.advanceTimersByTimeAsync(10);

        await resultP;

        const [, logContent] = mockWriteFileSync.mock.calls[0];
        expect(logContent).toContain('Stdout Truncated: true');
        expect(logContent).toContain('Stderr Truncated: true');
        expect(logContent).toContain('(TRUNCATED)');
      } finally {
        if (origLogLevel === undefined) {
          delete process.env.LOG_LEVEL;
        } else {
          process.env.LOG_LEVEL = origLogLevel;
        }
      }
    });
  });

  /* ============================================================== */
  /*  Edge cases                                                     */
  /* ============================================================== */

  describe('edge cases', () => {
    it('calls onProcess with the spawned child process', async () => {
      const onProcess = vi.fn();
      const spec = makeSpec({ onProcess });
      const resultP = executeRunnerProcess(spec);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      expect(onProcess).toHaveBeenCalledWith(fakeProc, 'test-proc');
    });

    it('writes input to stdin as JSON', async () => {
      const chunks: string[] = [];
      fakeProc.stdin.on('data', (d: Buffer) => chunks.push(d.toString()));

      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      const written = chunks.join('');
      const parsed = JSON.parse(written);
      expect(parsed.prompt).toBe('Hello there');
      expect(parsed.groupFolder).toBe('test-group');
    });

    it('handles empty stdout on exit code 0', async () => {
      const spec = makeSpec({ onOutput: undefined });
      const resultP = executeRunnerProcess(spec);

      // No stdout at all
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.error).toContain('Failed to parse runner output');
    });

    it('handles stderr lines being logged at debug level', async () => {
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      fakeProc.stderr.push('line one\nline two\n');
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      expect(mockLogger.debug).toHaveBeenCalledWith(
        { agent: 'test-group' },
        'line one',
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { agent: 'test-group' },
        'line two',
      );
    });

    it('uses AGENT_TIMEOUT when no options and no agentConfig timeout', async () => {
      // AGENT_TIMEOUT = 5000, IDLE_TIMEOUT = 5000
      // When options.timeoutMs is not set: Math.max(configuredTimeout, IDLE_TIMEOUT + 30000)
      // = Math.max(5000, 35000) = 35000
      const spec = makeSpec({ options: undefined });
      const resultP = executeRunnerProcess(spec);

      // Should NOT have timed out at 5 seconds
      await vi.advanceTimersByTimeAsync(5100);
      expect(fakeProc.kill).not.toHaveBeenCalled();

      // Should time out at 35 seconds
      await vi.advanceTimersByTimeAsync(30000);
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
    });

    it('uses exact timeoutMs when options.timeoutMs is provided (no Math.max)', async () => {
      // When options.timeoutMs IS set, it should use that value directly
      // without the Math.max(configuredTimeout, IDLE_TIMEOUT + 30_000) logic
      const spec = makeSpec({ options: { timeoutMs: 100 } });
      const resultP = executeRunnerProcess(spec);

      await vi.advanceTimersByTimeAsync(150);
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL');

      fakeProc.emit('close', 137);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('error');
      expect(result.error).toContain('timed out after 100ms');
    });

    it('buffers partial streaming markers until end marker arrives', async () => {
      // Covers line 118: endIdx === -1 break (start marker present but no end marker yet)
      const onOutput = vi.fn(async () => {});
      const spec = makeSpec({ onOutput, options: { timeoutMs: 5000 } });
      const resultP = executeRunnerProcess(spec);

      // Send start marker and JSON but NOT the end marker yet
      fakeProc.stdout.push(
        `${OUTPUT_START_MARKER}\n{"status":"success","result":"partial"}`,
      );
      await vi.advanceTimersByTimeAsync(10);

      // onOutput should NOT have been called — still buffering
      expect(onOutput).not.toHaveBeenCalled();

      // Now send the end marker
      fakeProc.stdout.push(`\n${OUTPUT_END_MARKER}\n`);
      await vi.advanceTimersByTimeAsync(10);

      // Now it should have been called
      expect(onOutput).toHaveBeenCalledTimes(1);
      expect(onOutput).toHaveBeenCalledWith(
        expect.objectContaining({ result: 'partial' }),
      );

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      const result = await resultP;
      expect(result.status).toBe('success');
    });

    it('skips empty stderr lines in debug logging', async () => {
      // Covers lines 147: if (line) — false branch for empty lines
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      // Send stderr with empty lines interspersed
      fakeProc.stderr.push('real line\n\n\nanother line\n');
      await vi.advanceTimersByTimeAsync(10);

      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;

      // Only non-empty lines should be logged
      const debugCalls = mockLogger.debug.mock.calls.filter(
        (call) => call[0]?.agent === 'test-group',
      );
      const loggedLines = debugCalls.map((call) => call[1]);
      expect(loggedLines).toContain('real line');
      expect(loggedLines).toContain('another line');
      // Empty strings should NOT appear
      expect(loggedLines.every((l: string) => l.length > 0)).toBe(true);
    });

    it('stops accumulating stderr after truncation but still logs lines', async () => {
      // Covers line 149: if (stderrTruncated) return;
      const spec = makeSpec();
      const resultP = executeRunnerProcess(spec);

      // First chunk fills up stderr (AGENT_MAX_OUTPUT_SIZE = 512)
      fakeProc.stderr.push('Z'.repeat(600));
      await vi.advanceTimersByTimeAsync(10);

      // Clear the warn mock so we can check if a second truncation warn fires
      mockLogger.warn.mockClear();

      // Second chunk after truncation — should be ignored for accumulation
      fakeProc.stderr.push('AFTER_TRUNCATION\n');
      await vi.advanceTimersByTimeAsync(10);

      // No second truncation warning should fire
      const truncWarnCalls = mockLogger.warn.mock.calls.filter((call) =>
        String(call[1]).includes('stderr truncated'),
      );
      expect(truncWarnCalls).toHaveLength(0);

      // The "AFTER_TRUNCATION" line should still be debug-logged though
      expect(mockLogger.debug).toHaveBeenCalledWith(
        { agent: 'test-group' },
        'AFTER_TRUNCATION',
      );

      fakeProc.emit('close', 1);
      await vi.advanceTimersByTimeAsync(10);

      await resultP;
    });
  });
});
