/**
 * ExecHandle implementation — wraps container-runtime.ts to spawn commands
 * inside the agent container for auth flows.
 */
import { exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE, DATA_DIR, IDLE_TIMEOUT, TIMEZONE } from '../config.js';
import { CONTAINER_RUNTIME_BIN, stopContainer } from '../container-runtime.js';
import { logger } from '../logger.js';
import type { ExecHandle } from './types.js';

export interface ExecContainerOpts {
  /** Provider-specific bind mounts as [hostPath, containerPath, mode?] tuples. */
  mounts?: Array<[string, string, string?]>;
}

// Shim xdg-open: captures OAuth URL and exits 0 so CLI thinks browser opened.
const XDG_OPEN_SHIM = path.join(process.cwd(), 'container', 'shims', 'xdg-open');

/**
 * Spawn a command inside a nanoclaw-agent container.
 *
 * Infrastructure mounts (always added):
 *   - xdg-open shim at /usr/local/bin and /usr/bin (captures OAuth URLs)
 *   - auth-ipc dir at /workspace/auth-ipc (shim writes .oauth-url here)
 *
 * Provider-specific mounts come through opts.mounts.
 *
 * @param command - Command and args to run
 * @param sessionDir - Host path for this auth session (used for auth-ipc subdir)
 * @param opts - Optional provider-specific mounts
 */
export function execInContainer(
  command: string[],
  sessionDir: string,
  opts: ExecContainerOpts = {},
): ExecHandle {
  const authIpcDir = path.join(sessionDir, 'auth-ipc');
  fs.mkdirSync(authIpcDir, { recursive: true });

  const containerName = `nanoclaw-auth-${Date.now()}`;
  const args: string[] = [
    'run',
    '-i',
    '--rm',
    '--name',
    containerName,
    // Host networking so the CLI's OAuth callback server on localhost:{port}
    // is reachable from the host (needed for the callback code delivery path).
    '--network',
    'host',
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

  // Infrastructure mounts
  args.push('-v', `${authIpcDir}:/workspace/auth-ipc`);
  if (fs.existsSync(XDG_OPEN_SHIM)) {
    args.push('-v', `${XDG_OPEN_SHIM}:/usr/local/bin/xdg-open:ro`);
    args.push('-v', `${XDG_OPEN_SHIM}:/usr/bin/xdg-open:ro`);
  }

  // Provider-specific mounts
  for (const [hostPath, containerPath, mode] of opts.mounts ?? []) {
    if (fs.existsSync(hostPath)) {
      args.push('-v', mode ? `${hostPath}:${containerPath}:${mode}` : `${hostPath}:${containerPath}`);
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

  // Hard timeout — uses IDLE_TIMEOUT from config: auth is waiting for user
  // input, same as an idle agent waiting for IPC. Same kill mechanics as
  // container-runner.ts (docker stop → SIGKILL fallback).
  const killTimer = setTimeout(() => {
    logger.warn({ containerName, timeoutMs: IDLE_TIMEOUT }, 'Auth container timeout, stopping gracefully');
    exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
      if (err) {
        logger.warn({ containerName, err }, 'Graceful stop failed, force killing');
        proc.kill('SIGKILL');
      }
    });
  }, IDLE_TIMEOUT);

  proc.on('close', () => clearTimeout(killTimer));

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
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) proc.kill('SIGKILL');
      });
    },
  };
}

/** Resolve the auth session directory for a scope. */
export function authSessionDir(scope: string): string {
  return path.join(DATA_DIR, 'sessions', scope, '.claude-auth');
}
