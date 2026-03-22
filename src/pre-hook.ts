import { execFile } from 'child_process';

import { PreHook } from './types.js';

export interface PreHookResult {
  action: 'proceed' | 'skip' | 'error';
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

const MAX_TIMEOUT_S = 300;
const DEFAULT_TIMEOUT_S = 30;
const MAX_BUFFER = 64 * 1024;

export function runPreHook(hook: PreHook): Promise<PreHookResult> {
  const timeoutMs =
    Math.min(hook.timeout_seconds ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S) * 1000;
  const start = Date.now();

  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', hook.command],
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - start;

        if (!error) {
          resolve({
            action: 'proceed',
            exitCode: 0,
            stdout,
            stderr,
            durationMs,
          });
          return;
        }

        // Timeout — error.killed is true when the process was killed by timeout
        if (error.killed) {
          resolve({
            action: 'error',
            exitCode: -1,
            stdout: stdout || '',
            stderr: `preHook timed out after ${Math.ceil(timeoutMs / 1000)}s`,
            durationMs,
          });
          return;
        }

        const err = error as Error & { code?: number | string };
        const exitCode =
          typeof err.code === 'number' ? err.code : 1;

        resolve({
          action: exitCode === 10 ? 'skip' : 'error',
          exitCode,
          stdout: stdout || '',
          stderr: stderr || '',
          durationMs,
        });
      },
    );
  });
}
