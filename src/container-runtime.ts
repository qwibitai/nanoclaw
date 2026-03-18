/**
 * Tmux session runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Replaces the previous Docker-based container runtime with native tmux sessions.
 * Agents now run directly on the host inside isolated tmux sessions.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/**
 * Address the credential proxy binds to.
 * With tmux, agents run directly on the host, so the proxy is always reachable
 * on 127.0.0.1.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || '127.0.0.1';

/** Returns the shell command to kill a tmux session by name. */
export function stopSession(name: string): string {
  return `tmux kill-session -t ${name}`;
}

/** Check whether a tmux session exists. Returns true if alive. */
export function hasSession(name: string): boolean {
  try {
    execSync(`tmux has-session -t ${name}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Ensure tmux is available on the host. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync('tmux -V', {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Tmux runtime available');
  } catch (err) {
    logger.error({ err }, 'Failed to find tmux');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: tmux is not installed or not in PATH                  ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without tmux. To fix:                      ║',
    );
    console.error(
      '║  1. Install tmux (apt install tmux / brew install tmux)       ║',
    );
    console.error(
      '║  2. Run: tmux -V                                              ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                          ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('tmux is required but not found', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw tmux sessions from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `tmux list-sessions -F '#{session_name}' 2>/dev/null || true`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output
      .trim()
      .split('\n')
      .filter((name) => name.startsWith('nanoclaw-'));
    for (const name of orphans) {
      try {
        execSync(stopSession(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned tmux sessions',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned sessions');
  }
}
