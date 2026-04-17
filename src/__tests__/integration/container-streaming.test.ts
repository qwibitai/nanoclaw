/**
 * Integration: container-runner streaming-parser edge cases.
 *
 * Expands on container-runner.test.ts with the scenarios that are most
 * likely to break when Phase D splits the streaming parser out: chunk
 * boundaries that cut an OUTPUT_START_MARKER in half, interleaved
 * stderr noise, and compact_boundary signalling. Landing these here
 * gives us an early-warning net for the split.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

vi.mock('../../config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    CONTAINER_IMAGE: 'nanoclaw-agent:latest',
    CONTAINER_MAX_OUTPUT_SIZE: 10485760,
    CONTAINER_TIMEOUT: 1800000,
    DATA_DIR: '/tmp/nanoclaw-streaming-test',
    GROUPS_DIR: '/tmp/nanoclaw-streaming-groups',
    IDLE_TIMEOUT: 1800000,
    ONECLI_URL: 'http://localhost:10254',
    TIMEZONE: 'UTC',
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

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
    },
  };
});

vi.mock('../../mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('../../container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = vi.fn().mockResolvedValue(true);
    createAgent = vi.fn().mockResolvedValue({ id: 'test' });
    ensureAgent = vi
      .fn()
      .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
  },
}));

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
  proc.pid = 42;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

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

import {
  type ContainerOutput,
  runContainerAgent,
} from '../../container-runner.js';
import type { RegisteredGroup } from '../../types.js';

const group: RegisteredGroup = {
  name: 'Test',
  folder: 'test',
  trigger: '@Andy',
  added_at: '2026-01-01T00:00:00.000Z',
};
const input = {
  prompt: 'hi',
  groupFolder: 'test',
  chatJid: 'test@g.us',
  isMain: false,
};

function markerPayload(output: ContainerOutput): string {
  return `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`;
}

describe('integration: container streaming parser edge cases', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reassembles a marker split across two stdout chunks', async () => {
    const onOutput = vi.fn(async () => {});
    const run = runContainerAgent(group, input, () => {}, onOutput);

    const payload = markerPayload({ status: 'success', result: 'chunked' });
    const mid = Math.floor(payload.length / 2);
    fakeProc.stdout.push(payload.slice(0, mid));
    await vi.advanceTimersByTimeAsync(5);
    fakeProc.stdout.push(payload.slice(mid));
    await vi.advanceTimersByTimeAsync(5);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await run;

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'chunked' }),
    );
  });

  it('extracts newSessionId and surfaces it on final result', async () => {
    const onOutput = vi.fn(async () => {});
    const run = runContainerAgent(group, input, () => {}, onOutput);

    fakeProc.stdout.push(
      markerPayload({
        status: 'success',
        result: 'ok',
        newSessionId: 'sess-xyz',
      }),
    );
    await vi.advanceTimersByTimeAsync(5);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);

    const result = await run;
    expect(result.newSessionId).toBe('sess-xyz');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ newSessionId: 'sess-xyz' }),
    );
  });

  it('propagates compact_boundary markers to the onOutput callback', async () => {
    const onOutput = vi.fn<(o: ContainerOutput) => Promise<void>>(
      async () => {},
    );
    const run = runContainerAgent(group, input, () => {}, onOutput);

    fakeProc.stdout.push(
      markerPayload({ status: 'success', result: null, compacted: true }),
    );
    await vi.advanceTimersByTimeAsync(5);
    fakeProc.stdout.push(
      markerPayload({ status: 'success', result: 'post-compact answer' }),
    );
    await vi.advanceTimersByTimeAsync(5);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await run;

    const outputs = onOutput.mock.calls.map((c) => c[0]);
    expect(outputs.some((o) => o.compacted === true)).toBe(true);
    expect(outputs.some((o) => o.result === 'post-compact answer')).toBe(true);
  });

  it('stderr noise does not interfere with stdout marker parsing', async () => {
    const onOutput = vi.fn(async () => {});
    const run = runContainerAgent(group, input, () => {}, onOutput);

    fakeProc.stderr.push('[agent-runner] starting up\n');
    fakeProc.stdout.push(
      markerPayload({ status: 'success', result: 'despite stderr' }),
    );
    fakeProc.stderr.push('[agent-runner] shutdown\n');
    await vi.advanceTimersByTimeAsync(5);
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await run;

    expect(onOutput).toHaveBeenCalledTimes(1);
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'despite stderr' }),
    );
  });

  it('non-zero exit without output produces an error result', async () => {
    const onOutput = vi.fn(async () => {});
    const run = runContainerAgent(group, input, () => {}, onOutput);

    fakeProc.stderr.push('boom\n');
    await vi.advanceTimersByTimeAsync(5);
    fakeProc.emit('close', 2);
    await vi.advanceTimersByTimeAsync(10);

    const result = await run;
    expect(result.status).toBe('error');
    expect(onOutput).not.toHaveBeenCalled();
  });
});
