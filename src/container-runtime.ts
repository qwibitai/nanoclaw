/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN =
  process.env.CONTAINER_RUNTIME_BIN ||
  process.env.CONTAINER_RUNTIME ||
  'container';

const IS_APPLE_CONTAINER_RUNTIME = /(^|\/)container$/.test(
  CONTAINER_RUNTIME_BIN,
);

function runtimeHealthCommand(): string {
  return IS_APPLE_CONTAINER_RUNTIME
    ? `${CONTAINER_RUNTIME_BIN} system status`
    : `${CONTAINER_RUNTIME_BIN} info`;
}

function runtimeListContainersCommand(): string {
  return IS_APPLE_CONTAINER_RUNTIME
    ? `${CONTAINER_RUNTIME_BIN} ls -a`
    : `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`;
}

function parseNanoclawContainers(output: string): string[] {
  if (!output.trim()) return [];

  if (IS_APPLE_CONTAINER_RUNTIME) {
    const lines = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= 1) return [];
    return lines
      .slice(1)
      .map((line) => line.split(/\s+/)[0])
      .filter((name) => name.startsWith('nanoclaw-'));
  }

  return output
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  if (IS_APPLE_CONTAINER_RUNTIME) {
    return [
      '--mount',
      `type=bind,source=${hostPath},target=${containerPath},readonly`,
    ];
  }
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(runtimeHealthCommand(), {
      stdio: 'pipe',
      timeout: 10000,
    });
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
      `║  1. Ensure ${CONTAINER_RUNTIME_BIN} is installed and running                ║`,
    );
    console.error(
      `║  2. Run: ${runtimeHealthCommand().padEnd(53)}║`,
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(runtimeListContainersCommand(), {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const orphans = parseNanoclawContainers(output);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
