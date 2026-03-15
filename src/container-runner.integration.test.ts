/**
 * Integration tests for container-runner.
 * These tests spawn real Docker containers and verify the end-to-end
 * IPC round-trip including sentinel marker parsing, streaming output,
 * and timeout handling.
 *
 * Gated behind TEST_DOCKER=1 to avoid requiring Docker in CI by default.
 *
 *   TEST_DOCKER=1 npm test -- src/container-runner.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync, ChildProcess } from 'child_process';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const SKIP = !process.env.TEST_DOCKER;
const TEST_IMAGE = 'alpine:latest';

// Helper: run a command in a Docker container, pipe input via stdin,
// and collect stdout/stderr until the container exits.
function runContainer(opts: {
  args: string[];
  stdin?: string;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Test helper timed out'));
    }, opts.timeoutMs ?? 30_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    if (opts.stdin != null) {
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    }
  });
}

// Helper: parse sentinel markers from raw stdout (mirrors container-runner logic)
function parseMarkers(
  raw: string,
): Array<{ status: string; result: string | null; [k: string]: unknown }> {
  const results: Array<{
    status: string;
    result: string | null;
    [k: string]: unknown;
  }> = [];
  let buf = raw;
  let startIdx: number;
  while ((startIdx = buf.indexOf(OUTPUT_START_MARKER)) !== -1) {
    const endIdx = buf.indexOf(OUTPUT_END_MARKER, startIdx);
    if (endIdx === -1) break;
    const json = buf
      .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
      .trim();
    try {
      results.push(JSON.parse(json));
    } catch {
      /* skip unparseable */
    }
    buf = buf.slice(endIdx + OUTPUT_END_MARKER.length);
  }
  return results;
}

describe.skipIf(SKIP)('container-runner integration (TEST_DOCKER=1)', () => {
  beforeAll(() => {
    // Pull the test image so individual tests don't time out on first pull
    try {
      execSync(`docker pull ${TEST_IMAGE}`, { stdio: 'pipe', timeout: 60_000 });
    } catch {
      // Image may already exist locally
    }
  });

  // Track containers spawned by tests so we can clean up
  const containers: string[] = [];
  afterAll(() => {
    for (const name of containers) {
      try {
        execSync(`docker rm -f ${name}`, { stdio: 'pipe' });
      } catch {
        /* already gone */
      }
    }
  });

  it('spawns a container, receives sentinel-marked output, and exits cleanly', async () => {
    const containerName = `nanoclaw-inttest-spawn-${Date.now()}`;
    containers.push(containerName);

    // The container reads JSON from stdin, wraps a response in sentinel markers,
    // and prints it to stdout — mimicking what agent-runner does.
    const shellScript = [
      // Read stdin into a variable
      'INPUT=$(cat)',
      // Echo some noise before the marker (simulates SDK debug output)
      'echo "debug: starting up"',
      'echo "debug: processing request"',
      // Emit a sentinel-wrapped JSON response
      `echo "${OUTPUT_START_MARKER}"`,
      `echo '{"status":"success","result":"hello from container","newSessionId":"sess-42"}'`,
      `echo "${OUTPUT_END_MARKER}"`,
      // Exit cleanly
      'exit 0',
    ].join(' && ');

    const input = JSON.stringify({
      prompt: 'integration test',
      groupFolder: 'test',
      chatJid: 'test@test',
      isMain: false,
    });

    const { stdout, code } = await runContainer({
      args: [
        'run',
        '-i',
        '--rm',
        '--name',
        containerName,
        TEST_IMAGE,
        '/bin/sh',
        '-c',
        shellScript,
      ],
      stdin: input,
    });

    expect(code).toBe(0);

    // Parse sentinel markers from stdout
    const parsed = parseMarkers(stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].status).toBe('success');
    expect(parsed[0].result).toBe('hello from container');
    expect(parsed[0].newSessionId).toBe('sess-42');

    // Verify noise before markers didn't corrupt parsing
    expect(stdout).toContain('debug: starting up');
  });

  it('parses multiple sentinel marker pairs from streaming output', async () => {
    const containerName = `nanoclaw-inttest-multi-${Date.now()}`;
    containers.push(containerName);

    // Emit two separate sentinel-marked outputs (simulates streaming mode)
    const shellScript = [
      `echo "${OUTPUT_START_MARKER}"`,
      `echo '{"status":"success","result":"chunk 1","newSessionId":"sess-1"}'`,
      `echo "${OUTPUT_END_MARKER}"`,
      'echo "interleaved noise"',
      `echo "${OUTPUT_START_MARKER}"`,
      `echo '{"status":"success","result":"chunk 2","newSessionId":"sess-2"}'`,
      `echo "${OUTPUT_END_MARKER}"`,
    ].join(' && ');

    const { stdout, code } = await runContainer({
      args: [
        'run',
        '-i',
        '--rm',
        '--name',
        containerName,
        TEST_IMAGE,
        '/bin/sh',
        '-c',
        shellScript,
      ],
      stdin: '',
    });

    expect(code).toBe(0);

    const parsed = parseMarkers(stdout);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].result).toBe('chunk 1');
    expect(parsed[1].result).toBe('chunk 2');
    expect(parsed[1].newSessionId).toBe('sess-2');
  });

  it('handles timeout by killing a long-running container', async () => {
    const containerName = `nanoclaw-inttest-timeout-${Date.now()}`;
    containers.push(containerName);

    // Spawn a container that sleeps forever
    const proc = spawn(
      'docker',
      [
        'run',
        '-i',
        '--rm',
        '--name',
        containerName,
        TEST_IMAGE,
        '/bin/sh',
        '-c',
        'sleep 3600',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let exited = false;
    let exitCode: number | null = null;

    const exitPromise = new Promise<void>((resolve) => {
      proc.on('close', (code) => {
        exited = true;
        exitCode = code;
        resolve();
      });
    });

    // Give the container a moment to start
    await new Promise((r) => setTimeout(r, 2000));

    // Simulate the timeout kill path: docker stop then SIGKILL fallback
    try {
      execSync(`docker stop -t 2 ${containerName}`, {
        stdio: 'pipe',
        timeout: 10_000,
      });
    } catch {
      // Container may already be gone
      proc.kill('SIGKILL');
    }

    await exitPromise;

    expect(exited).toBe(true);
    // docker stop sends SIGTERM then SIGKILL — exit code is typically 137 (128+9)
    // or 143 (128+15), or null if already cleaned up
    expect(exitCode).not.toBe(0);
  }, 30_000);

  it('returns non-zero exit code when container command fails', async () => {
    const containerName = `nanoclaw-inttest-fail-${Date.now()}`;
    containers.push(containerName);

    const { code, stderr } = await runContainer({
      args: [
        'run',
        '-i',
        '--rm',
        '--name',
        containerName,
        TEST_IMAGE,
        '/bin/sh',
        '-c',
        'echo "something went wrong" >&2 && exit 1',
      ],
      stdin: '',
    });

    expect(code).toBe(1);
    expect(stderr).toContain('something went wrong');
  });

  it('streams sentinel markers incrementally as they arrive', async () => {
    const containerName = `nanoclaw-inttest-stream-${Date.now()}`;
    containers.push(containerName);

    // Emit markers with delays to simulate real streaming
    const shellScript = [
      `echo "${OUTPUT_START_MARKER}"`,
      `echo '{"status":"success","result":"first"}'`,
      `echo "${OUTPUT_END_MARKER}"`,
      'sleep 1',
      `echo "${OUTPUT_START_MARKER}"`,
      `echo '{"status":"success","result":"second"}'`,
      `echo "${OUTPUT_END_MARKER}"`,
    ].join(' && ');

    // Use streaming parsing (like container-runner does)
    const proc = spawn(
      'docker',
      [
        'run',
        '-i',
        '--rm',
        '--name',
        containerName,
        TEST_IMAGE,
        '/bin/sh',
        '-c',
        shellScript,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const streamedResults: Array<{
      status: string;
      result: string | null;
    }> = [];
    let parseBuffer = '';

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('Streaming test timed out'));
      }, 15_000);

      proc.stdout.on('data', (data) => {
        parseBuffer += data.toString();
        let startIdx: number;
        while (
          (startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1
        ) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;
          const json = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(
            endIdx + OUTPUT_END_MARKER.length,
          );
          try {
            streamedResults.push(JSON.parse(json));
          } catch {
            /* skip */
          }
        }
      });

      proc.on('close', () => {
        clearTimeout(timer);
        resolve();
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      proc.stdin.end();
    });

    expect(streamedResults).toHaveLength(2);
    expect(streamedResults[0].result).toBe('first');
    expect(streamedResults[1].result).toBe('second');
  }, 20_000);
});
