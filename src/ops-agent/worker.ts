/**
 * Ops-Agent Worker
 *
 * Long-lived process that polls Agency HQ for ops tasks (task_type=ops, status=ready),
 * executes them via the Claude Code CLI with full host access, and reports results back.
 *
 * Unlike dev-inbox workers, this process is persistent and has access to operational
 * commands (systemctl, journalctl, df, ps, etc.).
 *
 * Usage:
 *   npx tsx src/ops-agent/worker.ts
 */
import { execSync, spawn } from 'child_process';

import {
  agencyFetch,
  fetchPersona,
  type AgencyHqTask,
} from '../agency-hq-client.js';
import { AGENCY_HQ_URL, AGENT_CLI_BIN } from '../config.js';
import {
  getEffectiveConfig,
  startConfigPolling,
  stopConfigPolling,
  type ResolvedConfig,
  _resetForTest as _resetConfigForTest,
} from './dispatch-config.js';
import { createCorrelationLogger, logger } from '../logger.js';
import { StreamToolLogger } from '../stream-tool-logger.js';

// --- Configuration ---

const OPS_POLL_INTERVAL_MS = parseInt(
  process.env.OPS_POLL_INTERVAL_MS || '10000',
  10,
);
const OPS_TASK_TIMEOUT_MS = parseInt(
  process.env.OPS_TASK_TIMEOUT_MS || '300000',
  10,
); // 5 min default
const OPS_PERSONA_KEY =
  process.env.OPS_PERSONA_KEY ||
  'agency/engineering/engineering-backend-developer';

// --- State ---

let stopping = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let activeAbort: AbortController | null = null;

// --- Helpers ---

/** Fetch tasks from Agency HQ filtered by task_type=ops and status=ready. */
export async function fetchOpsTasks(): Promise<AgencyHqTask[]> {
  const res = await agencyFetch('/tasks?task_type=ops&status=ready');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Agency HQ returned ${res.status}: ${body}`);
  }
  const json = (await res.json()) as { success: boolean; data: AgencyHqTask[] };
  return json.data ?? [];
}

/** Claim a task by marking it in-progress in Agency HQ. */
export async function claimTask(task: AgencyHqTask): Promise<boolean> {
  const res = await agencyFetch(`/tasks/${task.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      status: 'in-progress',
      dispatched_at: new Date().toISOString(),
      dispatch_attempts: (task.dispatch_attempts ?? 0) + 1,
    }),
  });
  return res.ok;
}

/** Build the prompt for an ops task, including persona context. */
export async function buildOpsPrompt(task: AgencyHqTask): Promise<string> {
  const parts: string[] = [task.title, '', task.description];

  if (task.acceptance_criteria) {
    parts.push('', `Acceptance Criteria: ${task.acceptance_criteria}`);
  }

  // Inject persona for execution context
  const persona = await fetchPersona(OPS_PERSONA_KEY);
  if (persona) {
    parts.push('', `## Execution Persona (${OPS_PERSONA_KEY})`, '', persona);
  }

  parts.push(
    '',
    '## Host Access',
    '',
    'You have full host access. You may run operational commands such as:',
    '- systemctl, journalctl (service management and logs)',
    '- df, du, free, ps, top (system diagnostics)',
    '- docker, git, npm (development tooling)',
    '- Any other CLI tool available on this host',
    '',
    `Agency HQ task ID: ${task.id}`,
  );

  return parts.join('\n');
}

/**
 * Build CLI arguments for a given provider.
 * Each provider has different flags for permission bypass, model selection, and prompt delivery.
 */
export function buildCliArgs(config: ResolvedConfig, prompt: string): string[] {
  switch (config.provider) {
    case 'kimi':
      return [
        '--print',
        ...(config.model ? ['-m', config.model] : []),
        prompt,
      ];
    case 'copilot':
      return [
        '--allow-all-tools',
        '--allow-all-paths',
        '--allow-all-urls',
        '--no-ask-user',
        ...(config.model ? ['--model', config.model] : []),
        '-p',
        prompt,
      ];
    case 'gemini':
      return [
        '--approval-mode',
        'yolo',
        ...(config.model ? ['-m', config.model] : []),
        prompt,
      ];
    case 'codex':
      return [
        'exec',
        '--full-auto',
        '--skip-git-repo-check',
        ...(config.model ? ['-m', config.model] : []),
        prompt,
      ];
    case 'claude':
    default:
      return [
        '--print',
        '--output-format',
        'stream-json',
        '--dangerously-skip-permissions',
        ...(config.model ? ['--model', config.model] : []),
        prompt,
      ];
  }
}

/**
 * Execute an ops task via the configured CLI.
 * Uses dispatch-config for provider/model when available, falls back to env vars.
 * Returns { result, error } where result is stdout and error is set on failure.
 * Logs tool call events to the database when using stream-json output.
 */
export async function executeTask(
  prompt: string,
  timeoutMs: number = OPS_TASK_TIMEOUT_MS,
): Promise<{ result: string | null; error: string | null }> {
  const abort = new AbortController();
  activeAbort = abort;

  const config = getEffectiveConfig();
  const toolLogger = new StreamToolLogger('ops-agent');

  return new Promise((resolve) => {
    const args = buildCliArgs(config, prompt);

    // Copilot rejects classic GitHub PATs — unset GITHUB_TOKEN
    const spawnEnv = { ...process.env };
    if (config.provider === 'copilot') {
      delete spawnEnv.GITHUB_TOKEN;
    }

    const proc = spawn(config.cliBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: abort.signal,
      env: spawnEnv,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBuffer = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);

      // Parse stream-json lines for tool events (Claude provider only)
      if (config.provider === 'claude') {
        stdoutBuffer += chunk.toString('utf-8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          toolLogger.processLine(line);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      abort.abort();
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      activeAbort = null;

      // Process any remaining buffered line
      if (stdoutBuffer && config.provider === 'claude') {
        toolLogger.processLine(stdoutBuffer);
      }

      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();

      if (abort.signal.aborted && code !== 0) {
        resolve({
          result: stdout || null,
          error: `Task timed out after ${timeoutMs}ms`,
        });
        return;
      }

      if (code !== 0) {
        resolve({
          result: stdout || null,
          error: stderr || `Process exited with code ${code}`,
        });
        return;
      }

      resolve({ result: stdout || null, error: null });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      activeAbort = null;
      resolve({ result: null, error: err.message });
    });

    // Close stdin immediately — Claude CLI reads from args, not stdin
    proc.stdin.end();
  });
}

/** Report task result back to Agency HQ and mark as done or ready (for retry). */
export async function reportResult(
  taskId: string,
  result: string | null,
  error: string | null,
  log: ReturnType<typeof createCorrelationLogger>,
): Promise<void> {
  const succeeded = error === null;
  const summary = succeeded
    ? (result?.slice(0, 2000) ?? 'Task completed (no output captured)')
    : `Error: ${error}`;

  // Fetch existing context for merging
  let existingContext: Record<string, unknown> = {};
  try {
    const getRes = await agencyFetch(`/tasks/${taskId}`);
    if (getRes.ok) {
      const getJson = (await getRes.json()) as {
        success: boolean;
        data: { context?: Record<string, unknown> };
      };
      existingContext = getJson.data?.context ?? {};
    }
  } catch (err) {
    log.warn({ err, taskId }, 'Failed to GET task for context merge');
  }

  const mergedContext = { ...existingContext, result: { summary } };
  const status = succeeded ? 'done' : 'ready';

  try {
    const res = await agencyFetch(`/tasks/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify({ status, context: mergedContext }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error(
        { status: res.status, body, taskId },
        'Failed to report result to Agency HQ',
      );
    } else {
      log.info({ taskId, status }, 'Result reported to Agency HQ');
    }
  } catch (err) {
    log.error({ err, taskId }, 'Failed to PUT result to Agency HQ');
  }

  // Post notification for completed tasks
  if (succeeded) {
    try {
      await agencyFetch('/notifications', {
        method: 'POST',
        body: JSON.stringify({
          type: 'ops-task-complete',
          title: `Ops task completed: ${taskId}`,
          target: 'ceo',
          channel: 'telegram',
          reference_type: 'task',
          reference_id: taskId,
        }),
      });
    } catch (err) {
      log.warn({ err, taskId }, 'Failed to POST completion notification');
    }
  }
}

/** Process a single ops task: claim, execute, report. */
export async function processTask(task: AgencyHqTask): Promise<void> {
  const log = createCorrelationLogger(undefined, {
    op: 'ops-agent',
    taskId: task.id,
  });

  log.info({ title: task.title }, 'Processing ops task');

  // Claim the task
  const claimed = await claimTask(task);
  if (!claimed) {
    log.warn('Failed to claim task, skipping');
    return;
  }

  // Build prompt and execute
  const prompt = await buildOpsPrompt(task);
  log.info('Executing ops task via CLI');

  const { result, error } = await executeTask(prompt);

  if (error) {
    log.error({ error }, 'Ops task failed');
  } else {
    log.info(
      { resultLength: result?.length ?? 0 },
      'Ops task completed successfully',
    );
  }

  // Report result back to Agency HQ
  await reportResult(task.id, result, error, log);
}

// --- Poll Loop ---

/** Single poll tick: fetch ready ops tasks and process them sequentially. */
export async function pollTick(): Promise<void> {
  if (stopping) return;

  const log = createCorrelationLogger(undefined, { op: 'ops-agent' });

  try {
    const tasks = await fetchOpsTasks();
    if (tasks.length === 0) return;

    log.info({ count: tasks.length }, 'Found ready ops tasks');

    for (const task of tasks) {
      if (stopping) return;

      // Skip held tasks
      if (task.assigned_to === 'hold') {
        log.debug({ taskId: task.id }, 'Skipping held task');
        continue;
      }

      // Skip tasks blocked until a future time
      if (task.dispatch_blocked_until) {
        const blockedUntil = new Date(task.dispatch_blocked_until).getTime();
        if (blockedUntil > Date.now()) {
          log.debug(
            { taskId: task.id, blockedUntil: task.dispatch_blocked_until },
            'Skipping blocked task',
          );
          continue;
        }
      }

      // Skip future-scheduled tasks
      if (task.scheduled_dispatch_at) {
        const scheduledAt = new Date(task.scheduled_dispatch_at).getTime();
        if (scheduledAt > Date.now()) {
          log.debug({ taskId: task.id }, 'Skipping future-scheduled task');
          continue;
        }
      }

      await processTask(task);
    }
  } catch (err) {
    log.error({ err }, 'Error during ops poll tick');
  }
}

/** Start the polling loop. Returns a cleanup function. */
export async function startPolling(): Promise<() => void> {
  // Fetch dispatch-config before starting task polling
  await startConfigPolling();

  const effective = getEffectiveConfig();
  logger.info(
    {
      pollIntervalMs: OPS_POLL_INTERVAL_MS,
      taskTimeoutMs: OPS_TASK_TIMEOUT_MS,
      agencyHqUrl: AGENCY_HQ_URL,
      cliBin: effective.cliBin,
      model: effective.model,
      provider: effective.provider,
    },
    'Ops-agent worker starting',
  );

  const poll = async () => {
    if (stopping) return;
    await pollTick();
    if (!stopping) {
      pollTimer = setTimeout(poll, OPS_POLL_INTERVAL_MS);
    }
  };

  // Start first tick immediately
  pollTimer = setTimeout(poll, 0);

  return shutdown;
}

/** Gracefully shut down the worker. */
export function shutdown(): void {
  if (stopping) return;
  stopping = true;
  logger.info('Ops-agent worker shutting down');

  stopConfigPolling();

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  // Abort any running task
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
}

/** Reset internal state (for testing). */
export function _resetForTest(): void {
  stopping = false;
  pollTimer = null;
  activeAbort = null;
  _resetConfigForTest();
}

// --- Entrypoint ---

if (process.argv[1] && process.argv[1].includes('ops-agent/worker')) {
  // Verify CLI binary is available (check env default; dispatch-config
  // may override at runtime, but the default must exist on disk)
  try {
    execSync(`which ${AGENT_CLI_BIN}`, { stdio: 'pipe' });
  } catch {
    logger.fatal(
      { cliBin: AGENT_CLI_BIN },
      'Agent CLI binary not found in PATH',
    );
    process.exit(1);
  }

  startPolling().then((cleanup) => {
    process.on('SIGTERM', () => {
      logger.info('Received SIGTERM');
      cleanup();
    });

    process.on('SIGINT', () => {
      logger.info('Received SIGINT');
      cleanup();
    });
  });
}
