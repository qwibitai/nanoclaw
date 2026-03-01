/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

const isLinux = process.platform === 'linux';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = isLinux ? 'docker' : 'container';

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

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  if (isLinux) {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 10000 });
      logger.debug('Docker runtime already running');
    } catch (err) {
      logger.error({ err }, 'Failed to reach Docker runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Docker runtime failed to start                         ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without Docker. To fix:                     ║',
      );
      console.error(
        '║  1. Install Docker: https://docs.docker.com/get-docker         ║',
      );
      console.error(
        '║  2. Start Docker: systemctl start docker                       ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Docker runtime is required but failed to start');
    }
  } else {
    try {
      execSync('container system status', { stdio: 'pipe', timeout: 10000 });
      logger.debug('Apple Container system already running');
    } catch {
      logger.info('Starting Apple Container system...');
      try {
        execSync('container system start', { stdio: 'pipe', timeout: 30000 });
        logger.info('Apple Container system started');
      } catch (err) {
        logger.error({ err }, 'Failed to start Apple Container system');
        console.error(
          '\n╔════════════════════════════════════════════════════════════════╗',
        );
        console.error(
          '║  FATAL: Apple Container system failed to start                 ║',
        );
        console.error(
          '║                                                                ║',
        );
        console.error(
          '║  Agents cannot run without Apple Container. To fix:            ║',
        );
        console.error(
          '║  1. Install from: https://github.com/apple/container/releases  ║',
        );
        console.error(
          '║  2. Run: container system start                                ║',
        );
        console.error(
          '║  3. Restart NanoClaw                                           ║',
        );
        console.error(
          '╚════════════════════════════════════════════════════════════════╝\n',
        );
        throw new Error('Apple Container system is required but failed to start');
      }
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    let orphans: string[] = [];
    if (isLinux) {
      const output = execSync(
        `docker ps --filter name=nanoclaw- --format '{{.Names}}'`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      orphans = output.trim().split('\n').filter(Boolean);
    } else {
      const output = execSync('container ls --format json', {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      // Handle empty output and gracefully parse
      const containers = JSON.parse(output || '[]');
      orphans = containers
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => c.status === 'running' && c.configuration?.id?.startsWith('nanoclaw-'))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c.configuration.id);
    }

    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
