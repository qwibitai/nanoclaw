import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts (lines 33-34)
// These are CRITICAL contracts between host and container
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
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
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
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
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import type { RegisteredGroup } from './types.js';

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

/**
 * CONTRACT: Sentinel marker values
 * These markers are the protocol boundary between host and container.
 * Changing them breaks the container-to-host communication protocol.
 */
describe('CONTAINER-RUNNER CONTRACT: Sentinel marker values', () => {
  it('OUTPUT_START_MARKER must be exactly ---NANOCLAW_OUTPUT_START---', () => {
    // This test ensures the marker value is locked
    expect(OUTPUT_START_MARKER).toBe('---NANOCLAW_OUTPUT_START---');
  });

  it('OUTPUT_END_MARKER must be exactly ---NANOCLAW_OUTPUT_END---', () => {
    // This test ensures the marker value is locked
    expect(OUTPUT_END_MARKER).toBe('---NANOCLAW_OUTPUT_END---');
  });

  it('markers must not contain whitespace variations', () => {
    // Ensure markers don't have leading/trailing whitespace
    expect(OUTPUT_START_MARKER).toBe(OUTPUT_START_MARKER.trim());
    expect(OUTPUT_END_MARKER).toBe(OUTPUT_END_MARKER.trim());
  });

  it('markers must be distinguishable from each other', () => {
    // Ensure start and end markers are different
    expect(OUTPUT_START_MARKER).not.toBe(OUTPUT_END_MARKER);
  });
});

/**
 * CONTRACT: Streaming parser behavior (lines 351-377 in container-runner.ts)
 * The streaming parser extracts JSON between marker pairs and handles:
 * - newSessionId extraction
 * - Multiple output chunks
 * - Invalid JSON handling (logs warning, continues)
 */
describe('CONTAINER-RUNNER CONTRACT: Streaming parser behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function emitOutputMarker(
    proc: ReturnType<typeof createFakeProcess>,
    output: ContainerOutput,
  ) {
    const json = JSON.stringify(output);
    proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
  }

  it('extracts newSessionId from streaming output markers', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with newSessionId
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Response text',
      newSessionId: 'sess-abc-123',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // CONTRACT: newSessionId from streaming markers propagates to final result
    expect(result.newSessionId).toBe('sess-abc-123');
  });

  it('handles multiple streaming output markers in sequence', async () => {
    const receivedOutputs: ContainerOutput[] = [];
    const onOutput = vi.fn(async (output: ContainerOutput) => {
      receivedOutputs.push(output);
    });

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit multiple outputs
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'First chunk',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Second chunk',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
    // CONTRACT: Each marker pair triggers onOutput callback
    expect(receivedOutputs).toHaveLength(2);
    expect(receivedOutputs[0].result).toBe('First chunk');
    expect(receivedOutputs[1].result).toBe('Second chunk');
  });

  it('captures last newSessionId when multiple markers have different session IDs', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {},
    );

    // Emit multiple outputs with different session IDs
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'First',
      newSessionId: 'session-first',
    });
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Second',
      newSessionId: 'session-last',
    });

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // CONTRACT: Last session ID wins in streaming mode
    expect(result.newSessionId).toBe('session-last');
  });

  it('handles marker data arriving in chunks (incomplete start marker)', async () => {
    const receivedOutputs: ContainerOutput[] = [];
    const onOutput = vi.fn(async (output: ContainerOutput) => {
      receivedOutputs.push(output);
    });

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Send marker in multiple chunks to test buffering
    const json = JSON.stringify({ status: 'success', result: 'chunked' });
    fakeProc.stdout.push(OUTPUT_START_MARKER.slice(0, 10));
    await vi.advanceTimersByTimeAsync(1);
    fakeProc.stdout.push(OUTPUT_START_MARKER.slice(10));
    fakeProc.stdout.push(`\n${json}\n`);
    fakeProc.stdout.push(OUTPUT_END_MARKER.slice(0, 10));
    await vi.advanceTimersByTimeAsync(1);
    fakeProc.stdout.push(OUTPUT_END_MARKER.slice(10) + '\n');

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
    // CONTRACT: Parser must handle chunked data correctly
    expect(receivedOutputs).toHaveLength(1);
    expect(receivedOutputs[0].result).toBe('chunked');
  });
});

/**
 * CONTRACT: Legacy mode output parsing (lines 582-598 in container-runner.ts)
 * When onOutput callback is NOT provided, the runner falls back to legacy mode
 * which parses the last marker pair from accumulated stdout.
 */
describe('CONTAINER-RUNNER CONTRACT: Legacy mode output parsing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses output from first marker pair in legacy mode (no onOutput)', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      // No onOutput callback = legacy mode
      undefined,
    );

    // Emit multiple outputs - first pair is parsed (indexOf finds first occurrence)
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n{"status":"success","result":"first","newSessionId":"sess-first"}\n${OUTPUT_END_MARKER}\n`,
    );
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n{"status":"success","result":"last","newSessionId":"sess-last"}\n${OUTPUT_END_MARKER}\n`,
    );

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // CONTRACT: Legacy mode returns the FIRST parsed output (indexOf behavior)
    expect(result.result).toBe('first');
    expect(result.newSessionId).toBe('sess-first');
  });

  it('falls back to last non-empty line when markers not found', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      undefined,
    );

    // Emit JSON without markers (backwards compatibility)
    fakeProc.stdout.push('some log line\n');
    fakeProc.stdout.push('{"status":"success","result":"fallback"}\n');

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    // CONTRACT: Fallback to last line for backwards compatibility
    expect(result.result).toBe('fallback');
  });
});

/**
 * CONTRACT: Marker format and content expectations
 * The container expects to wrap JSON output with these exact markers.
 */
describe('CONTAINER-RUNNER CONTRACT: Marker format expectations', () => {
  it('markers are wrapped with triple dashes', () => {
    // CONTRACT: Markers use triple-dash format
    expect(OUTPUT_START_MARKER.startsWith('---')).toBe(true);
    expect(OUTPUT_START_MARKER.endsWith('---')).toBe(true);
    expect(OUTPUT_END_MARKER.startsWith('---')).toBe(true);
    expect(OUTPUT_END_MARKER.endsWith('---')).toBe(true);
  });

  it('marker names follow NANOCLAW_OUTPUT_* pattern', () => {
    // CONTRACT: Marker naming convention for consistency
    expect(OUTPUT_START_MARKER).toContain('NANOCLAW_OUTPUT_START');
    expect(OUTPUT_END_MARKER).toContain('NANOCLAW_OUTPUT_END');
  });
});

/**
 * CONTRACT: Error handling for malformed output
 * The parser must handle malformed JSON gracefully.
 */
describe('CONTAINER-RUNNER CONTRACT: Malformed output handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs warning but continues when JSON parsing fails in streaming mode', async () => {
    const { logger } = await import('./logger.js');
    const onOutput = vi.fn(async () => {});

    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit malformed JSON between valid markers
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\nnot valid json\n${OUTPUT_END_MARKER}\n`,
    );
    // Followed by valid output
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n{"status":"success","result":"valid"}\n${OUTPUT_END_MARKER}\n`,
    );

    await vi.advanceTimersByTimeAsync(10);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    await resultPromise;
    // CONTRACT: Warning is logged for invalid JSON
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.anything(),
      }),
      'Failed to parse streamed output chunk',
    );
    // CONTRACT: Valid output after invalid is still processed
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'valid' }),
    );
  });
});
