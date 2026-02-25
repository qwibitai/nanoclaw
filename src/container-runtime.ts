/**
 * Container runtime abstraction for CamBot-Agent.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, { stdio: 'pipe', timeout: 10000 });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart CamBot-Agent                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** List running cambot containers by name prefix. */
function listContainers(prefix: string): string[] {
  const output = execSync(
    `${CONTAINER_RUNTIME_BIN} ps --filter name=${prefix} --format {{.Names}}`,
    { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
  );
  return output.trim().split('\n')
    .map(n => n.replace(/['"]/g, '').trim())
    .filter(Boolean);
}

/** Kill orphaned CamBot-Agent containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const orphans = listContainers('cambot-agent-');
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe', timeout: 15000 });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }

    // Verify all orphans are actually dead — force-kill any survivors.
    // docker stop can silently fail on Windows when names have unexpected
    // quoting or when the container is stuck in a non-interruptible syscall.
    const survivors = listContainers('cambot-agent-');
    for (const name of survivors) {
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} kill ${name}`, { stdio: 'pipe', timeout: 10000 });
      } catch { /* ignore */ }
    }
    if (survivors.length > 0) {
      logger.warn({ count: survivors.length, names: survivors }, 'Force-killed surviving orphaned containers');
    }

    // Also clean up orphaned worker containers
    const workerOrphans = listContainers('cambot-worker-');
    for (const name of workerOrphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe', timeout: 15000 });
      } catch { /* already stopped */ }
    }
    if (workerOrphans.length > 0) {
      logger.info({ count: workerOrphans.length, names: workerOrphans }, 'Stopped orphaned worker containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
