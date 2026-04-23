import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgencyHqTask } from '../agency-hq-client.js';

// Mock child_process before imports
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

import {
  fetchOpsTasks,
  claimTask,
  buildOpsPrompt,
  buildCliArgs,
  executeTask,
  reportResult,
  pollTick,
  startPolling,
  shutdown,
  _resetForTest,
} from './worker.js';
import { resolveConfig } from './dispatch-config.js';
import { createCorrelationLogger } from '../logger.js';
import { spawn } from 'child_process';

function makeMockTask(overrides?: Partial<AgencyHqTask>): AgencyHqTask {
  return {
    id: 'ops-task-1',
    title: 'Check disk usage',
    description: 'Run df -h and report results',
    status: 'ready',
    ...overrides,
  };
}

function mockFetchResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

describe('ops-agent/worker', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetForTest();
    fetchMock = vi
      .fn()
      .mockResolvedValue(mockFetchResponse({ success: true, data: [] }));
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    shutdown();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('fetchOpsTasks', () => {
    it('fetches tasks with task_type=ops and status=ready', async () => {
      const tasks = [makeMockTask()];
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ success: true, data: tasks }),
      );

      const result = await fetchOpsTasks();
      expect(result).toEqual(tasks);

      // Verify the URL includes the task_type filter
      const call = fetchMock.mock.calls[0];
      expect(call[0]).toContain('/tasks?task_type=ops&status=ready');
    });

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ error: 'server error' }, false, 500),
      );

      await expect(fetchOpsTasks()).rejects.toThrow('Agency HQ returned 500');
    });

    it('returns empty array when no data field', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ success: true }));

      const result = await fetchOpsTasks();
      expect(result).toEqual([]);
    });
  });

  describe('claimTask', () => {
    it('marks task in-progress via PUT', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ success: true }));

      const task = makeMockTask();
      const result = await claimTask(task);
      expect(result).toBe(true);

      const call = fetchMock.mock.calls[0];
      expect(call[0]).toContain(`/tasks/${task.id}`);
      expect(call[1].method).toBe('PUT');
      const body = JSON.parse(call[1].body);
      expect(body.status).toBe('in-progress');
      expect(body.dispatched_at).toBeDefined();
    });

    it('returns false on failure', async () => {
      fetchMock.mockResolvedValueOnce(mockFetchResponse({}, false, 409));

      const result = await claimTask(makeMockTask());
      expect(result).toBe(false);
    });
  });

  describe('buildOpsPrompt', () => {
    it('includes task title, description, and host access section', async () => {
      // Mock persona fetch — second call (first is the prompt registry)
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ data: { value: 'You are a backend engineer.' } }),
      );

      const task = makeMockTask({ acceptance_criteria: 'Disk usage < 80%' });
      const prompt = await buildOpsPrompt(task);

      expect(prompt).toContain('Check disk usage');
      expect(prompt).toContain('Run df -h and report results');
      expect(prompt).toContain('Acceptance Criteria: Disk usage < 80%');
      expect(prompt).toContain('Host Access');
      expect(prompt).toContain('systemctl');
      expect(prompt).toContain(`Agency HQ task ID: ${task.id}`);
    });

    it('works without persona fetch', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network error'));

      const prompt = await buildOpsPrompt(makeMockTask());
      expect(prompt).toContain('Check disk usage');
      expect(prompt).toContain('Host Access');
    });
  });

  describe('executeTask', () => {
    it('spawns CLI using dispatch-config defaults (env fallback)', async () => {
      const mockProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { end: vi.fn() },
        on: vi.fn(),
      };

      vi.mocked(spawn).mockReturnValue(mockProc as never);

      const promise = executeTask('test prompt', 5000);

      // Without dispatch-config, should use env default 'claude' and no --model flag
      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['--print', '--dangerously-skip-permissions', 'test prompt'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );

      // Simulate stdout data
      const stdoutHandler = mockProc.stdout.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'data',
      )![1];
      stdoutHandler(Buffer.from('Task output'));

      // Simulate close with success
      const closeHandler = mockProc.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'close',
      )![1];
      closeHandler(0);

      const result = await promise;
      expect(result.result).toBe('Task output');
      expect(result.error).toBeNull();
    });

    it('passes --model flag when dispatch-config provides a model', async () => {
      // Seed dispatch-config with a model
      const { refreshConfig } = await import('./dispatch-config.js');
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          success: true,
          data: { model: 'claude-sonnet-4-5-20250929', cli_bin: 'claude' },
        }),
      );
      await refreshConfig();

      const mockProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { end: vi.fn() },
        on: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(mockProc as never);

      const promise = executeTask('test prompt', 5000);

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        [
          '--print',
          '--dangerously-skip-permissions',
          '--model',
          'claude-sonnet-4-5-20250929',
          'test prompt',
        ],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );

      // Simulate close
      const closeHandler = mockProc.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'close',
      )![1];
      closeHandler(0);
      await promise;
    });

    it('reports error on non-zero exit code', async () => {
      const mockProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { end: vi.fn() },
        on: vi.fn(),
      };

      vi.mocked(spawn).mockReturnValue(mockProc as never);

      const promise = executeTask('test prompt', 5000);

      const stderrHandler = mockProc.stderr.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'data',
      )![1];
      stderrHandler(Buffer.from('Something went wrong'));

      const closeHandler = mockProc.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'close',
      )![1];
      closeHandler(1);

      const result = await promise;
      expect(result.error).toBe('Something went wrong');
    });

    it('handles spawn error', async () => {
      const mockProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { end: vi.fn() },
        on: vi.fn(),
      };

      vi.mocked(spawn).mockReturnValue(mockProc as never);

      const promise = executeTask('test prompt', 5000);

      const errorHandler = mockProc.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'error',
      )![1];
      errorHandler(new Error('ENOENT'));

      const result = await promise;
      expect(result.error).toBe('ENOENT');
      expect(result.result).toBeNull();
    });
  });

  describe('resolveConfig', () => {
    it('maps provider to cliBin when cli_bin is absent', () => {
      const config = resolveConfig({ provider: 'kimi' });
      expect(config.provider).toBe('kimi');
      expect(config.cliBin).toBe('kimi');
    });

    it('prefers explicit cli_bin over provider mapping', () => {
      const config = resolveConfig({ provider: 'kimi', cli_bin: '/usr/local/bin/kimi-custom' });
      expect(config.cliBin).toBe('/usr/local/bin/kimi-custom');
    });

    it('falls back to AGENT_CLI_BIN for unknown provider', () => {
      const config = resolveConfig({ provider: 'unknown-provider' });
      expect(config.provider).toBe('unknown-provider');
      // Falls back to AGENT_CLI_BIN (default: 'claude')
      expect(config.cliBin).toBe('claude');
    });
  });

  describe('buildCliArgs', () => {
    it('claude: uses --print --dangerously-skip-permissions', () => {
      const args = buildCliArgs({ provider: 'claude', cliBin: 'claude', model: undefined }, 'do stuff');
      expect(args).toEqual(['--print', '--dangerously-skip-permissions', 'do stuff']);
    });

    it('claude: includes --model when set', () => {
      const args = buildCliArgs({ provider: 'claude', cliBin: 'claude', model: 'claude-sonnet-4-5-20250929' }, 'do stuff');
      expect(args).toContain('--model');
      expect(args).toContain('claude-sonnet-4-5-20250929');
    });

    it('kimi: uses --print, -m, no --dangerously-skip-permissions', () => {
      const args = buildCliArgs({ provider: 'kimi', cliBin: 'kimi', model: 'k2-0520' }, 'do stuff');
      expect(args).toEqual(['--print', '-m', 'k2-0520', 'do stuff']);
      expect(args).not.toContain('--dangerously-skip-permissions');
    });

    it('kimi: omits -m when no model', () => {
      const args = buildCliArgs({ provider: 'kimi', cliBin: 'kimi', model: undefined }, 'do stuff');
      expect(args).toEqual(['--print', 'do stuff']);
    });

    it('copilot: uses allow flags and -p for prompt', () => {
      const args = buildCliArgs({ provider: 'copilot', cliBin: 'copilot', model: undefined }, 'do stuff');
      expect(args).toContain('--allow-all-tools');
      expect(args).toContain('--no-ask-user');
      expect(args).toContain('-p');
      expect(args[args.length - 1]).toBe('do stuff');
    });

    it('gemini: uses --approval-mode yolo', () => {
      const args = buildCliArgs({ provider: 'gemini', cliBin: 'gemini', model: 'gemini-2.5-pro' }, 'do stuff');
      expect(args).toContain('--approval-mode');
      expect(args).toContain('yolo');
      expect(args).toContain('-m');
      expect(args).toContain('gemini-2.5-pro');
    });

    it('codex: uses exec --full-auto --skip-git-repo-check', () => {
      const args = buildCliArgs({ provider: 'codex', cliBin: 'codex', model: undefined }, 'do stuff');
      expect(args).toEqual(['exec', '--full-auto', '--skip-git-repo-check', 'do stuff']);
    });

    it('unknown provider falls through to claude defaults', () => {
      const args = buildCliArgs({ provider: 'future-ai', cliBin: 'future-ai', model: undefined }, 'do stuff');
      expect(args).toContain('--print');
      expect(args).toContain('--dangerously-skip-permissions');
    });
  });

  describe('executeTask with kimi provider', () => {
    it('spawns kimi binary with correct args', async () => {
      // Seed dispatch-config with kimi provider
      const { refreshConfig } = await import('./dispatch-config.js');
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'kimi', model: 'k2-0520' },
        }),
      );
      await refreshConfig();

      const mockProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { end: vi.fn() },
        on: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(mockProc as never);

      const promise = executeTask('test prompt', 5000);

      expect(spawn).toHaveBeenCalledWith(
        'kimi',
        ['--print', '-m', 'k2-0520', 'test prompt'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );

      const closeHandler = mockProc.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'close',
      )![1];
      closeHandler(0);
      await promise;
    });
  });

  describe('executeTask with copilot provider', () => {
    it('spawns copilot without GITHUB_TOKEN in env', async () => {
      const { refreshConfig } = await import('./dispatch-config.js');
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          success: true,
          data: { provider: 'copilot' },
        }),
      );
      await refreshConfig();

      const mockProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { end: vi.fn() },
        on: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(mockProc as never);

      // Set GITHUB_TOKEN to verify it gets stripped
      process.env.GITHUB_TOKEN = 'ghp_test123';
      const promise = executeTask('test prompt', 5000);

      expect(spawn).toHaveBeenCalledWith(
        'copilot',
        expect.arrayContaining(['--allow-all-tools', '-p', 'test prompt']),
        expect.objectContaining({
          env: expect.not.objectContaining({ GITHUB_TOKEN: expect.anything() }),
        }),
      );

      delete process.env.GITHUB_TOKEN;

      const closeHandler = mockProc.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'close',
      )![1];
      closeHandler(0);
      await promise;
    });
  });

  describe('reportResult', () => {
    it('reports success to Agency HQ with done status', async () => {
      // First call: GET for context merge
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ success: true, data: { context: {} } }),
      );
      // Second call: PUT with result
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ success: true }));
      // Third call: POST notification
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ success: true }));

      const log = createCorrelationLogger(undefined, { op: 'test' });
      await reportResult('task-1', 'All good', null, log);

      // Verify PUT was called with done status
      const putCall = fetchMock.mock.calls[1];
      const body = JSON.parse(putCall[1].body);
      expect(body.status).toBe('done');
      expect(body.context.result.summary).toBe('All good');
    });

    it('reports failure to Agency HQ with ready status', async () => {
      // First call: GET for context merge
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ success: true, data: { context: {} } }),
      );
      // Second call: PUT with result
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ success: true }));

      const log = createCorrelationLogger(undefined, { op: 'test' });
      await reportResult('task-1', null, 'Command failed', log);

      const putCall = fetchMock.mock.calls[1];
      const body = JSON.parse(putCall[1].body);
      expect(body.status).toBe('ready');
      expect(body.context.result.summary).toContain('Error: Command failed');
    });
  });

  describe('pollTick', () => {
    it('skips held tasks', async () => {
      const tasks = [makeMockTask({ assigned_to: 'hold' })];
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ success: true, data: tasks }),
      );

      await pollTick();

      // Only the fetch call, no claim call
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('skips blocked tasks', async () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const tasks = [makeMockTask({ dispatch_blocked_until: future })];
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ success: true, data: tasks }),
      );

      await pollTick();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('skips future-scheduled tasks', async () => {
      const future = new Date(Date.now() + 3600_000).toISOString();
      const tasks = [makeMockTask({ scheduled_dispatch_at: future })];
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ success: true, data: tasks }),
      );

      await pollTick();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('handles fetch errors gracefully', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));

      // Should not throw
      await pollTick();
    });
  });

  describe('full lifecycle: poll -> claim -> execute -> complete', () => {
    it('processes a task end-to-end through pollTick', async () => {
      const task = makeMockTask();

      // 1. fetchOpsTasks — returns one ready task
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ success: true, data: [task] }),
      );
      // 2. claimTask — PUT in-progress
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ success: true }));
      // 3. buildOpsPrompt — persona fetch
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({
          data: { value: 'You are an ops engineer.' },
        }),
      );
      // 4. reportResult — GET existing context
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ success: true, data: { context: {} } }),
      );
      // 5. reportResult — PUT done
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ success: true }));
      // 6. reportResult — POST notification
      fetchMock.mockResolvedValueOnce(mockFetchResponse({ success: true }));

      // Mock spawn for executeTask
      const mockProc = {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { end: vi.fn() },
        on: vi.fn(),
      };
      vi.mocked(spawn).mockReturnValue(mockProc as never);

      const pollPromise = pollTick();

      // Wait for spawn to be called, then simulate CLI output
      await vi.advanceTimersByTimeAsync(0);

      const stdoutHandler = mockProc.stdout.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'data',
      )![1];
      stdoutHandler(Buffer.from('Disk usage: 42%'));

      const closeHandler = mockProc.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'close',
      )![1];
      closeHandler(0);

      await pollPromise;

      // Verify the full sequence of API calls:
      expect(fetchMock).toHaveBeenCalledTimes(6);

      // Call 1: fetch tasks
      expect(fetchMock.mock.calls[0][0]).toContain(
        '/tasks?task_type=ops&status=ready',
      );

      // Call 2: claim task (PUT in-progress)
      expect(fetchMock.mock.calls[1][0]).toContain(`/tasks/${task.id}`);
      expect(fetchMock.mock.calls[1][1].method).toBe('PUT');
      const claimBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(claimBody.status).toBe('in-progress');

      // Call 3: persona fetch for prompt building
      expect(fetchMock.mock.calls[2][0]).toContain('/prompts/');

      // Call 4: GET task for context merge
      expect(fetchMock.mock.calls[3][0]).toContain(`/tasks/${task.id}`);

      // Call 5: PUT result (done)
      expect(fetchMock.mock.calls[4][0]).toContain(`/tasks/${task.id}`);
      expect(fetchMock.mock.calls[4][1].method).toBe('PUT');
      const resultBody = JSON.parse(fetchMock.mock.calls[4][1].body);
      expect(resultBody.status).toBe('done');
      expect(resultBody.context.result.summary).toContain('Disk usage: 42%');

      // Call 6: POST notification
      expect(fetchMock.mock.calls[5][0]).toContain('/notifications');
      expect(fetchMock.mock.calls[5][1].method).toBe('POST');
    });
  });

  describe('startPolling / shutdown', () => {
    it('starts polling and can be shut down', async () => {
      // startPolling fetches dispatch-config first
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ success: true, data: {} }),
      );

      const cleanup = await startPolling();
      expect(typeof cleanup).toBe('function');
      cleanup();
    });

    it('stops processing on shutdown', async () => {
      // startPolling fetches dispatch-config first
      fetchMock.mockResolvedValueOnce(
        mockFetchResponse({ success: true, data: {} }),
      );

      await startPolling();
      shutdown();

      // Advance timers — pollTick should not run after shutdown
      fetchMock.mockClear();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
