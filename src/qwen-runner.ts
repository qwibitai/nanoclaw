/**
 * Qwen Runner for NanoClaw
 *
 * Replaces containerized Claude Code with Qwen Code CLI running directly on
 * the host. Qwen is spawned with --approval-mode yolo so all tools are
 * available (run_shell_command, edit, write_file, read_file, web_search, …)
 * without interactive prompts.
 *
 * Sessions are preserved via --resume <sessionId>. Each message spawns a
 * fresh qwen process; group-queue handles concurrency and session handoff.
 *
 * Same external interface as container-runner.ts so index.ts needs minimal
 * changes.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  IDLE_TIMEOUT,
} from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export type QwenErrorType =
  | 'stale-session'
  | 'context-exhausted'
  | 'non-retryable'
  | 'retryable';

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  errorType?: QwenErrorType;
}

const QWEN_BIN = process.env.QWEN_BIN || 'qwen';

/**
 * Classify a Qwen error from stdout/stderr text and exit code.
 * Used to decide retry strategy in the caller.
 */
export function classifyQwenError(
  text: string,
  _exitCode: number | null,
): QwenErrorType {
  const lower = text.toLowerCase();

  if (text.includes('No saved session found with ID')) return 'stale-session';

  // Context window exhaustion — clear session and let GroupQueue retry fresh
  if (
    (lower.includes('context') &&
      (lower.includes('length') ||
        lower.includes('window') ||
        lower.includes('maximum') ||
        lower.includes('exceed'))) ||
    (lower.includes('token') &&
      (lower.includes('limit') ||
        lower.includes('too many') ||
        lower.includes('maximum') ||
        lower.includes('exceed')))
  ) {
    return 'context-exhausted';
  }

  // Non-retryable 4xx (except 429 rate-limit and 408 timeout)
  const match = text.match(/\b(4\d\d)\b/);
  if (match) {
    const code = parseInt(match[1], 10);
    if (code >= 400 && code < 500 && code !== 429 && code !== 408) {
      return 'non-retryable';
    }
  }

  return 'retryable';
}

function readGlobalClaudeMd(projectRoot: string): string | null {
  const p = path.join(projectRoot, 'groups', 'global', 'CLAUDE.md');
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const globalClaudeMd = readGlobalClaudeMd(process.cwd());

  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  const args: string[] = [
    '--output-format',
    'stream-json',
    '--approval-mode',
    'yolo',
  ];

  if (input.sessionId) {
    args.push('--resume', input.sessionId);
  }

  if (globalClaudeMd) {
    args.push('--append-system-prompt', globalClaudeMd);
  }

  // Prompt as positional argument — spawn handles quoting, no shell injection risk
  args.push(prompt);

  const procName = `qwen-${group.folder}`;

  logger.info(
    {
      group: group.name,
      procName,
      sessionId: input.sessionId,
      isMain: input.isMain,
    },
    'Spawning Qwen agent',
  );

  const spawnQwen = (spawnArgs: string[]): Promise<ContainerOutput> =>
    new Promise((resolve) => {
      const proc = spawn(QWEN_BIN, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: groupDir,
      });

      onProcess(proc, procName);

      let stdout = '';
      let stdoutTruncated = false;
      let newSessionId: string | undefined;
      let hadOutput = false;
      let outputChain = Promise.resolve();

      proc.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();

        if (!stdoutTruncated) {
          const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
          if (chunk.length > remaining) {
            stdout += chunk.slice(0, remaining);
            stdoutTruncated = true;
            logger.warn(
              { group: group.name },
              'Qwen stdout truncated due to size limit',
            );
          } else {
            stdout += chunk;
          }
        }

        // Parse stream-json lines looking for the result event
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.type === 'result') {
              newSessionId = msg.session_id;
              hadOutput = true;
              resetTimeout();
              if (onOutput) {
                const output: ContainerOutput = {
                  status: msg.is_error ? 'error' : 'success',
                  result: msg.result ?? null,
                  newSessionId: msg.session_id,
                  ...(msg.is_error && { error: msg.result ?? 'Qwen error' }),
                };
                outputChain = outputChain.then(() => onOutput(output));
              }
            }
          } catch {
            // Non-JSON stdout lines are normal (debug output) — ignore
          }
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        for (const line of data.toString().trim().split('\n')) {
          if (line) logger.debug({ group: group.folder }, line);
        }
      });

      let timedOut = false;
      const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
      const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

      const killOnTimeout = () => {
        timedOut = true;
        logger.error(
          { group: group.name, procName },
          'Qwen agent timed out, killing',
        );
        proc.kill('SIGKILL');
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);
      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };

      proc.on('close', (code) => {
        clearTimeout(timeout);
        const duration = Date.now() - startTime;

        outputChain.then(() => {
          if (timedOut) {
            // If output was already sent, treat as idle cleanup (not failure)
            if (hadOutput) {
              resolve({ status: 'success', result: null, newSessionId });
            } else {
              resolve({
                status: 'error',
                result: null,
                error: `Qwen agent timed out after ${Math.round(duration / 1000)}s`,
                errorType: 'retryable',
              });
            }
            return;
          }

          if (hadOutput) {
            resolve({ status: 'success', result: null, newSessionId });
          } else if (
            code !== 0 &&
            stdout.includes('No saved session found with ID')
          ) {
            // Stale session ID from previous backend (Claude Code → Qwen migration).
            // Signal the caller to retry without --resume.
            resolve({
              status: 'error',
              result: null,
              error: 'stale-session',
              errorType: 'stale-session',
            });
          } else if (code !== 0) {
            const errText = stdout.slice(-2000);
            logger.error(
              { group: group.name, code, tail: errText.slice(-1000) },
              'Qwen exited with error, no output received',
            );
            resolve({
              status: 'error',
              result: null,
              error: `Qwen exited with code ${code}`,
              errorType: classifyQwenError(errText, code),
            });
          } else {
            // Clean exit with no result event — treat as silent success
            resolve({ status: 'success', result: null, newSessionId });
          }
        });
      });
    });

  const result = await spawnQwen(args);

  // If the session ID was stale (e.g. leftover from Claude Code), retry fresh.
  if (result.error === 'stale-session') {
    logger.warn(
      { group: group.name, sessionId: input.sessionId },
      'Stale session ID detected, retrying without --resume',
    );
    const freshArgs = args.filter(
      (a, i, arr) => a !== '--resume' && arr[i - 1] !== '--resume',
    );
    return spawnQwen(freshArgs);
  }

  return result;
}
