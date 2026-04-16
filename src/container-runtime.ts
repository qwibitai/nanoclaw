/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
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
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
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

/** Create a Docker network if it doesn't already exist. */
export function ensureDockerNetwork(name: string): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} network create ${name}`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.info({ network: name }, 'Docker network created');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) {
      logger.debug({ network: name }, 'Docker network already exists');
      return;
    }
    throw err;
  }
}

/** Start the browser sidecar via docker compose. */
export function ensureBrowserSidecar(): void {
  const composePath = path.join(process.cwd(), 'docker-compose.browser.yml');
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} compose -f ${composePath} up -d`, {
      stdio: 'pipe',
      timeout: 30000,
    });
    logger.info('Browser sidecar started');
  } catch (err) {
    logger.error(
      { err },
      'Failed to start browser sidecar (non-fatal, continuing without it)',
    );
  }
}

/** Stop the browser sidecar. */
export function stopBrowserSidecar(): void {
  const composePath = path.join(process.cwd(), 'docker-compose.browser.yml');
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} compose -f ${composePath} down`, {
      stdio: 'pipe',
      timeout: 15000,
    });
    logger.info('Browser sidecar stopped');
  } catch (err) {
    logger.warn({ err }, 'Failed to stop browser sidecar');
  }
}
