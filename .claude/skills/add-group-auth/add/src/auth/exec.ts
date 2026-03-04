/**
 * ExecHandle implementation — wraps container-runtime.ts to spawn commands
 * inside the agent container for auth flows.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, DATA_DIR, TIMEZONE } from '../config.js';
import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';
import { logger } from '../logger.js';
import type { ExecHandle } from './types.js';

export interface ExecContainerOpts {
  /** Additional readonly bind mounts as [hostPath, containerPath] pairs. */
  extraMounts?: Array<[string, string]>;
}

/**
 * Spawn a command inside a nanoclaw-agent container.
 *
 * @param command - Command and args to run (e.g. ['script', '-qc', 'claude setup-token', '/dev/null'])
 * @param sessionDir - Host path mounted at /home/node/.claude
 * @param opts - Optional extra mounts
 */
export function execInContainer(
  command: string[],
  sessionDir: string,
  opts: ExecContainerOpts = {},
): ExecHandle {
  fs.mkdirSync(sessionDir, { recursive: true });

  const containerName = `nanoclaw-auth-${Date.now()}`;
  const args: string[] = [
    'run',
    '-i',
    '--rm',
    '--name',
    containerName,
    '-e',
    `TZ=${TIMEZONE}`,
    '--entrypoint',
    '',
  ];

  // Run as host user if applicable (same logic as container-runner.ts)
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Mount session dir
  args.push('-v', `${sessionDir}:/home/node/.claude`);

  // Caller-supplied extra mounts (readonly)
  for (const [hostPath, containerPath] of opts.extraMounts ?? []) {
    if (fs.existsSync(hostPath)) {
      args.push('-v', `${hostPath}:${containerPath}:ro`);
    }
  }

  args.push(CONTAINER_IMAGE);
  args.push(...command);

  logger.debug(
    { containerName, command, sessionDir },
    'Spawning auth container',
  );

  const proc = spawn(CONTAINER_RUNTIME_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const stdoutCallbacks: Array<(chunk: string) => void> = [];

  proc.stdout.on('data', (data) => {
    const chunk = data.toString();
    stdout += chunk;
    for (const cb of stdoutCallbacks) cb(chunk);
  });

  proc.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  // Cache the wait promise so multiple calls don't hang
  let waitPromise: Promise<{ exitCode: number; stdout: string; stderr: string }> | null = null;

  return {
    onStdout(cb: (chunk: string) => void): void {
      stdoutCallbacks.push(cb);
    },
    stdin: {
      write(data: string): void {
        proc.stdin.write(data);
      },
      end(): void {
        proc.stdin.end();
      },
    },
    wait(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
      if (!waitPromise) {
        waitPromise = new Promise((resolve) => {
          proc.on('close', (code) => {
            resolve({ exitCode: code ?? 1, stdout, stderr });
          });
          proc.on('error', (err) => {
            logger.error({ containerName, err }, 'Auth container spawn error');
            resolve({ exitCode: 1, stdout, stderr: stderr + err.message });
          });
        });
      }
      return waitPromise;
    },
    kill(): void {
      proc.kill();
    },
  };
}

/** Resolve the auth session directory for a scope. */
export function authSessionDir(scope: string): string {
  return path.join(DATA_DIR, 'sessions', scope, '.claude-auth');
}
