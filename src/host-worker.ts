/**
 * Host Worker for NanoClaw
 * Spawns `claude -p` directly on the host (no container isolation).
 * Used for deep work: git operations, PR creation, multi-project access.
 *
 * Features:
 * - Streaming output (stream-json) — results sent to Discord as they arrive
 * - Follow-up IPC — watches ipc/input/ directory for new messages, pipes to stdin
 * - Session resumption — continues conversations across messages
 * - Model routing — supports --model flag for tier-based model selection
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ContainerOutput } from './container-runner.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface HostWorkerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  /** Claude model to use (haiku/sonnet/opus). If unset, uses default. */
  model?: string;
  /** Claude effort level (low/medium/high). Controls thinking budget. */
  effort?: string;
  /** Working directory for claude -p (defaults to HOME) */
  cwd?: string;
}

/** Default allowed tools for host workers */
const HOST_WORKER_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash', 'Agent', 'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
].join(',');

/** Projects the host worker can access */
const HOST_WORKER_ADD_DIRS = [
  '/root/neo-trading',
  '/root/nanoclaw',
  '/root/archive',
  '/root/neo-dashboard',
  '/home/andrea/kosmoy-website',
];

/**
 * Spawn a `claude -p` process on the host with full filesystem access.
 * Uses stream-json for real-time output and input-format stream-json for follow-ups.
 */
export async function runHostWorker(
  group: RegisteredGroup,
  input: HostWorkerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const workerName = `host-worker-${group.folder}-${Date.now()}`;
  const cwd = input.cwd || '/root';

  // Build claude -p args
  const args: string[] = [
    '-p', input.prompt,
    '--output-format', 'stream-json',
    '--verbose',
  ];

  // Model selection (haiku/sonnet/opus)
  if (input.model) {
    args.push('--model', input.model);
  }

  // Effort level (thinking budget: low/medium/high)
  if (input.effort) {
    args.push('--effort', input.effort);
  }

  // Session resumption
  if (input.sessionId) {
    args.push('--resume', input.sessionId);
  }

  // Tool access
  args.push('--allowedTools', HOST_WORKER_TOOLS);

  // Multi-project access
  for (const dir of HOST_WORKER_ADD_DIRS) {
    if (fs.existsSync(dir)) {
      args.push('--add-dir', dir);
    }
  }

  logger.info(
    { group: group.name, workerName, cwd, hasSession: !!input.sessionId, model: input.model || 'default' },
    'Spawning host worker',
  );

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        HOME: '/root',
        PATH: '/usr/local/bin:/usr/bin:/bin:/root/.local/bin',
        LANG: process.env.LANG || 'en_US.UTF-8',
        // Trigger auto-compaction early to prevent context rot (default ~95%)
        // Research shows 75% preserves ~50K tokens as working memory for reasoning
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '75',
      },
    });

    onProcess(proc, workerName);

    // Close stdin — claude -p processes the -p prompt and starts immediately
    // Follow-up messages are handled by spawning new workers with --resume
    proc.stdin.end();

    let stderr = '';
    let newSessionId: string | undefined;
    let hadOutput = false;
    let outputChain = Promise.resolve();
    let lineBuffer = '';

    // --- Streaming Output Parser ---
    // Parse stream-json: one JSON object per line
    proc.stdout.on('data', (data: Buffer) => {
      lineBuffer += data.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleStreamEvent(event);
        } catch {
          // Not JSON, skip
        }
      }
    });

    function handleStreamEvent(event: Record<string, unknown>): void {
      // Extract session ID from init message
      if (event.type === 'system' && event.session_id) {
        newSessionId = event.session_id as string;
        if (onOutput) {
          const output: ContainerOutput = {
            status: 'success',
            result: null,
            newSessionId,
          };
          outputChain = outputChain.then(() => onOutput(output));
        }
      }

      // Final result message
      if (event.type === 'result') {
        const result = event.result as string | undefined;
        if (result) {
          hadOutput = true;
          const output: ContainerOutput = {
            status: 'success',
            result,
            newSessionId: (event.session_id as string) || newSessionId,
          };
          if (onOutput) {
            outputChain = outputChain.then(() => onOutput(output));
          }
        }
        // Update session ID from result if present
        if (event.session_id) {
          newSessionId = event.session_id as string;
        }
      }
    }

    proc.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      for (const line of chunk.trim().split('\n')) {
        if (line) logger.debug({ worker: group.folder }, line);
      }
    });

    proc.on('close', (code) => {
      const duration = Date.now() - startTime;

      // Process remaining buffer
      if (lineBuffer.trim()) {
        try {
          const event = JSON.parse(lineBuffer);
          handleStreamEvent(event);
        } catch {
          // ignore
        }
      }

      // Write log
      const logsDir = path.join(DATA_DIR, '..', 'groups', group.folder, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `host-worker-${ts}.log`);
      fs.writeFileSync(logFile, [
        `=== Host Worker Log ===`,
        `Worker: ${workerName}`,
        `Group: ${group.name}`,
        `CWD: ${cwd}`,
        `Model: ${input.model || 'default'}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Session ID: ${newSessionId || 'none'}`,
        `Had Output: ${hadOutput}`,
        ``,
        `=== Stderr (last 2000 chars) ===`,
        stderr.slice(-2000),
      ].join('\n'));

      if (code !== 0 && !hadOutput) {
        logger.error(
          { group: group.name, workerName, code, duration },
          'Host worker exited with error',
        );
        outputChain.then(() => {
          resolve({
            status: 'error',
            result: null,
            error: `Host worker exited with code ${code}: ${stderr.slice(-200)}`,
          });
        });
        return;
      }

      logger.info(
        { group: group.name, workerName, duration, code, newSessionId, model: input.model || 'default' },
        'Host worker completed',
      );

      outputChain.then(() => {
        resolve({
          status: 'success',
          result: null,
          newSessionId,
        });
      });
    });

    proc.on('error', (err) => {
      logger.error({ group: group.name, workerName, error: err }, 'Host worker spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Host worker spawn error: ${err.message}`,
      });
    });
  });
}
