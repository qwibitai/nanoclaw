/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { exec, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CONTAINER_NAME_PREFIX } from './config.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Async container stop. Swallows "already stopped" errors. */
export async function stopContainerAsync(
  name: string,
  timeoutSeconds = 10,
): Promise<void> {
  try {
    await execAsync(
      `${CONTAINER_RUNTIME_BIN} stop -t ${timeoutSeconds} ${name}`,
    );
    logger.info({ name }, 'Container stopped');
  } catch (err) {
    // Swallow errors from containers that are already stopped
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('No such container') || msg.includes('is not running')) {
      logger.debug({ name }, 'Container already stopped');
    } else {
      logger.warn({ name, err }, 'Failed to stop container');
    }
  }
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
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Cached rootless detection result (doesn't change during process lifetime). */
let _isRootless: boolean | null = null;

/** Check if Docker is running in rootless mode. Result is cached. */
export function isRootlessDocker(): boolean {
  if (_isRootless !== null) return _isRootless;
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} info --format '{{json .SecurityOptions}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 5000 },
    );
    _isRootless = output.includes('rootless');
  } catch {
    _isRootless = false;
  }
  return _isRootless;
}

/** Probe rootless status eagerly (call at startup to avoid blocking later). */
export function probeRootlessDocker(): void {
  const rootless = isRootlessDocker();
  logger.debug({ rootless }, 'Docker rootless detection');
}

/** Cached Docker socket path (doesn't change during process lifetime). */
let _cachedDockerSocket: string | null | undefined = undefined;

/** Detect the Docker socket path. Checks rootless paths first, then standard. */
export function detectDockerSocket(): string | null {
  if (_cachedDockerSocket !== undefined) return _cachedDockerSocket;

  // Rootless: $XDG_RUNTIME_DIR/docker.sock or /run/user/{uid}/docker.sock
  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntime) {
    const sock = path.join(xdgRuntime, 'docker.sock');
    try {
      fs.statSync(sock);
      _cachedDockerSocket = sock;
      return sock;
    } catch {
      /* not here */
    }
  }

  const uid = process.getuid?.();
  if (uid != null && uid !== 0) {
    const sock = `/run/user/${uid}/docker.sock`;
    try {
      fs.statSync(sock);
      _cachedDockerSocket = sock;
      return sock;
    } catch {
      /* not here */
    }
  }

  // Standard rootful socket
  try {
    fs.statSync('/var/run/docker.sock');
    _cachedDockerSocket = '/var/run/docker.sock';
    return '/var/run/docker.sock';
  } catch {
    _cachedDockerSocket = null;
    return null;
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=${CONTAINER_NAME_PREFIX}- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
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
