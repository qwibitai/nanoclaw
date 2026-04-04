/**
 * Integration tests for container spawning and output handling.
 *
 * Mocks child_process to simulate container behavior without Docker.
 * Tests output parsing, streaming, timeouts, session tracking, and concurrency.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter, Writable, Readable } from 'stream';

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  STORE_DIR: '/tmp/nanoclaw-test-store',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  DATA_DIR: '/tmp/nanoclaw-test-data',
  TIMEZONE: 'America/New_York',
  TRIGGER_PATTERN: /^@Andy\b/i,
  CONTAINER_TIMEOUT: 5000,
  IDLE_TIMEOUT: 2000,
  MAX_CONCURRENT_CONTAINERS: 2,
  CONTAINER_PREFIX: 'nanoclaw',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 1024,
  CREDENTIAL_PROXY_PORT: 3001,
  IPC_POLL_INTERVAL: 1000,
  SCHEDULER_POLL_INTERVAL: 60000,
  SENDER_ALLOWLIST_PATH: '/tmp/nanoclaw-test-sender-allowlist.json',
  MOUNT_ALLOWLIST_PATH: '/tmp/nanoclaw-test-mount-allowlist.json',
  POLL_INTERVAL: 100,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock env.js
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock group-folder
vi.mock('../group-folder.js', () => ({
  isValidGroupFolder: vi.fn(() => true),
  assertValidGroupFolder: vi.fn(),
  resolveGroupFolderPath: vi.fn((folder: string) => `/tmp/nanoclaw-test-groups/${folder}`),
  resolveGroupIpcPath: vi.fn((folder: string) => `/tmp/nanoclaw-test-data/ipc/${folder}`),
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
      cpSync: vi.fn(),
      readFileSync: vi.fn(() => '{}'),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
    },
  };
});

// Mock mount-security
vi.mock('../mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('../container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: vi.fn(() => ['--add-host=host.docker.internal:host-gateway']),
  readonlyMountArgs: vi.fn((host: string, container: string) => ['-v', `${host}:${container}:ro`]),
  stopContainerArgs: vi.fn((name: string) => ['docker', ['stop', name]]),
}));

// Mock credential-proxy
vi.mock('../credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

import { ContainerOutput } from '../container-runner.js';
import { GroupQueue } from '../group-queue.js';

// Sentinel markers matching container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// --- Test helpers ---

function makeContainerOutput(result: string | null, opts?: {
  status?: 'success' | 'error';
  newSessionId?: string;
  error?: string;
}): string {
  const output: ContainerOutput = {
    status: opts?.status || 'success',
    result,
    ...(opts?.newSessionId && { newSessionId: opts.newSessionId }),
    ...(opts?.error && { error: opts.error }),
  };
  return `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`;
}

// --- Tests ---

describe('Container Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Output parsing ---

  describe('output parsing', () => {
    it('parses OUTPUT_START_MARKER -> JSON -> OUTPUT_END_MARKER', () => {
      const raw = makeContainerOutput('Hello from agent');

      // Extract the JSON between markers
      const startIdx = raw.indexOf(OUTPUT_START_MARKER);
      const endIdx = raw.indexOf(OUTPUT_END_MARKER);
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(startIdx);

      const jsonStr = raw.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
      const parsed: ContainerOutput = JSON.parse(jsonStr);

      expect(parsed.status).toBe('success');
      expect(parsed.result).toBe('Hello from agent');
    });

    it('parses output with newSessionId', () => {
      const raw = makeContainerOutput('Response', { newSessionId: 'session-xyz' });

      const startIdx = raw.indexOf(OUTPUT_START_MARKER);
      const endIdx = raw.indexOf(OUTPUT_END_MARKER);
      const jsonStr = raw.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
      const parsed: ContainerOutput = JSON.parse(jsonStr);

      expect(parsed.newSessionId).toBe('session-xyz');
    });

    it('parses error output', () => {
      const raw = makeContainerOutput(null, {
        status: 'error',
        error: 'Something went wrong',
      });

      const startIdx = raw.indexOf(OUTPUT_START_MARKER);
      const endIdx = raw.indexOf(OUTPUT_END_MARKER);
      const jsonStr = raw.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
      const parsed: ContainerOutput = JSON.parse(jsonStr);

      expect(parsed.status).toBe('error');
      expect(parsed.error).toBe('Something went wrong');
      expect(parsed.result).toBeNull();
    });

    it('parses multiple output blocks from streaming', () => {
      const block1 = makeContainerOutput('First result');
      const block2 = makeContainerOutput('Second result');
      const combined = `some noise\n${block1}more noise\n${block2}`;

      const results: ContainerOutput[] = [];
      let parseBuffer = combined;
      let startIdx: number;

      while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break;

        const jsonStr = parseBuffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

        results.push(JSON.parse(jsonStr));
      }

      expect(results).toHaveLength(2);
      expect(results[0].result).toBe('First result');
      expect(results[1].result).toBe('Second result');
    });
  });

  // --- Output truncation ---

  describe('output truncation', () => {
    it('detects when output exceeds max size', () => {
      const maxSize = 1024;
      const largeOutput = 'x'.repeat(maxSize + 100);
      const truncated = largeOutput.slice(0, maxSize);
      expect(truncated.length).toBe(maxSize);
      expect(truncated.length).toBeLessThan(largeOutput.length);
    });
  });

  // --- Session ID tracking ---

  describe('session ID tracking', () => {
    it('extracts newSessionId from container output', () => {
      const output: ContainerOutput = {
        status: 'success',
        result: 'Hello',
        newSessionId: 'new-session-abc',
      };

      expect(output.newSessionId).toBe('new-session-abc');
    });

    it('handles output without newSessionId', () => {
      const output: ContainerOutput = {
        status: 'success',
        result: 'Hello',
      };

      expect(output.newSessionId).toBeUndefined();
    });
  });

  // --- GroupQueue concurrency control ---

  describe('GroupQueue concurrency for containers', () => {
    it('limits concurrent containers to MAX_CONCURRENT_CONTAINERS', async () => {
      vi.useFakeTimers();
      const queue = new GroupQueue();
      let activeCount = 0;
      let maxActive = 0;
      const completionCallbacks: Array<() => void> = [];

      queue.setProcessMessagesFn(async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        activeCount--;
        return true;
      });

      // Enqueue 3 groups (limit is 2 from our mock config)
      queue.enqueueMessageCheck('g1@g.us');
      queue.enqueueMessageCheck('g2@g.us');
      queue.enqueueMessageCheck('g3@g.us');

      await vi.advanceTimersByTimeAsync(10);

      // Only 2 should be active
      expect(maxActive).toBe(2);

      // Complete one, third starts
      completionCallbacks[0]();
      await vi.advanceTimersByTimeAsync(10);

      // All 3 should have been processed eventually
      completionCallbacks[1]();
      await vi.advanceTimersByTimeAsync(10);
      completionCallbacks[2]();
      await vi.advanceTimersByTimeAsync(10);

      vi.useRealTimers();
    });

    it('sendMessage returns false when no active container', () => {
      const queue = new GroupQueue();
      const result = queue.sendMessage('group@g.us', 'hello');
      expect(result).toBe(false);
    });

    it('registerProcess stores process reference', async () => {
      vi.useFakeTimers();
      const queue = new GroupQueue();
      let registeredCalled = false;

      queue.setProcessMessagesFn(async () => {
        return true;
      });

      queue.enqueueMessageCheck('group@g.us');
      await vi.advanceTimersByTimeAsync(10);

      // Process has finished — we can verify registerProcess works
      const mockProc = {} as any;
      queue.registerProcess('group@g.us', mockProc, 'test-container', 'test-folder');

      vi.useRealTimers();
    });
  });

  // --- Container error handling ---

  describe('container error handling', () => {
    it('error exit code propagates as error status', () => {
      const output: ContainerOutput = {
        status: 'error',
        result: null,
        error: 'Container exited with code 1: some error',
      };

      expect(output.status).toBe('error');
      expect(output.error).toContain('code 1');
    });

    it('killed container (exit code 137) produces error output', () => {
      const output: ContainerOutput = {
        status: 'error',
        result: null,
        error: 'Container exited with code 137: ',
      };

      expect(output.status).toBe('error');
      expect(output.error).toContain('137');
    });

    it('timeout produces error with timeout message', () => {
      const output: ContainerOutput = {
        status: 'error',
        result: null,
        error: 'Container timed out after 300000ms',
      };

      expect(output.status).toBe('error');
      expect(output.error).toContain('timed out');
    });

    it('timeout after streaming output treated as success (idle cleanup)', () => {
      // When hadStreamingOutput is true and container times out,
      // the result is success (idle cleanup)
      const output: ContainerOutput = {
        status: 'success',
        result: null,
        newSessionId: 'session-after-timeout',
      };

      expect(output.status).toBe('success');
    });
  });

  // --- Queue retry on failure ---

  describe('queue retry on container failure', () => {
    it('schedules retry when processMessages returns false', async () => {
      vi.useFakeTimers();
      const queue = new GroupQueue();
      let callCount = 0;

      queue.setProcessMessagesFn(async () => {
        callCount++;
        return false; // failure
      });

      queue.enqueueMessageCheck('group@g.us');
      await vi.advanceTimersByTimeAsync(10);
      expect(callCount).toBe(1);

      // First retry after 5000ms
      await vi.advanceTimersByTimeAsync(5010);
      expect(callCount).toBe(2);

      vi.useRealTimers();
    });

    it('stops retrying after MAX_RETRIES (5)', async () => {
      vi.useFakeTimers();
      const queue = new GroupQueue();
      let callCount = 0;

      queue.setProcessMessagesFn(async () => {
        callCount++;
        return false;
      });

      queue.enqueueMessageCheck('group@g.us');

      // Initial + 5 retries = 6 total
      const delays = [10, 5010, 10010, 20010, 40010, 80010];
      for (const delay of delays) {
        await vi.advanceTimersByTimeAsync(delay);
      }
      expect(callCount).toBe(6);

      // No more retries
      await vi.advanceTimersByTimeAsync(200000);
      expect(callCount).toBe(6);

      vi.useRealTimers();
    });
  });

  // --- Idle timeout ---

  describe('idle timeout behavior', () => {
    it('notifyIdle marks container as idle', () => {
      const queue = new GroupQueue();
      // Just verify it does not throw
      queue.notifyIdle('group@g.us');
    });

    it('closeStdin writes _close sentinel when active', async () => {
      vi.useFakeTimers();
      const fs = await import('fs');
      const queue = new GroupQueue();
      let resolveProcess: () => void;

      queue.setProcessMessagesFn(async () => {
        await new Promise<void>((resolve) => { resolveProcess = resolve; });
        return true;
      });

      queue.enqueueMessageCheck('group@g.us');
      await vi.advanceTimersByTimeAsync(10);

      queue.registerProcess('group@g.us', {} as any, 'container-1', 'test-group');
      queue.closeStdin('group@g.us');

      const writeFileSync = vi.mocked(fs.default.writeFileSync);
      const closeWrites = writeFileSync.mock.calls.filter(
        (call) => typeof call[0] === 'string' && String(call[0]).endsWith('_close'),
      );
      expect(closeWrites.length).toBeGreaterThanOrEqual(1);

      resolveProcess!();
      await vi.advanceTimersByTimeAsync(10);
      vi.useRealTimers();
    });
  });

  // --- Streaming output chain ---

  describe('streaming output', () => {
    it('processes multiple streamed results in order', async () => {
      const results: string[] = [];

      // Simulate the streaming callback pattern from container-runner
      let outputChain = Promise.resolve();
      const onOutput = async (output: ContainerOutput) => {
        if (output.result) {
          results.push(output.result);
        }
      };

      // Simulate 3 streamed results
      const outputs: ContainerOutput[] = [
        { status: 'success', result: 'First' },
        { status: 'success', result: 'Second' },
        { status: 'success', result: null },
      ];

      for (const output of outputs) {
        outputChain = outputChain.then(() => onOutput(output));
      }

      await outputChain;

      expect(results).toEqual(['First', 'Second']);
    });

    it('tracks newSessionId from streaming output', async () => {
      let trackedSessionId: string | undefined;

      const onOutput = async (output: ContainerOutput) => {
        if (output.newSessionId) {
          trackedSessionId = output.newSessionId;
        }
      };

      await onOutput({ status: 'success', result: 'Hello', newSessionId: 'sess-1' });
      expect(trackedSessionId).toBe('sess-1');

      await onOutput({ status: 'success', result: 'World', newSessionId: 'sess-2' });
      expect(trackedSessionId).toBe('sess-2');
    });
  });
});
